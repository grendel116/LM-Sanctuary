import {
  applyRootProgramTheme,
  applyScopedProgramTheme,
} from '../constants/theme.js';
import { createOfflineNotice } from '../components/OfflineNotice.js';
import { openKnowledgeModal } from '../components/sanctuary/KnowledgeModal.js';
import {
  LIVE_ROW_SELECTOR,
  createIdleThoughtRow,
  createSharedPostEmbedCard,
  createTypingIndicatorRow,
  formatSharedPostForLlm,
  normalizeSharedPostCard,
  reconcileChat,
} from '../components/sanctuary/MessageRow.js';
import { createMoodHeart } from '../components/sanctuary/MoodHeart.js';
import {
  openLatestProgramMedia,
  openProgramGalleryModal,
  streamPortraitGeneration,
} from '../components/sanctuary/PortraitGrid.js';
import { openQuestModal } from '../components/sanctuary/QuestModal.js';
import { showAlert } from '../components/sanctuary/SanctuaryDialog.js';
import { startTurnToolMonitor } from '../components/sanctuary/ToolApprovalCard.js';
import { openVoiceCallOverlay } from '../components/sanctuary/VoiceCallOverlay.js';
import {
  cancelChat,
  continueGeneration,
  deleteMessage,
  editTurn,
  fetchModels,
  fetchRuntimeConfig,
  generateUserImpersonation,
  resolveSanctuaryMediaUrl,
  sendChat,
  synthesizeSpeech,
  updateMessageText,
  uploadSanctuaryMedia,
} from '../queries/sanctuary.js';
import {
  connectionStore,
  getProgramAvatarVersion,
  onSanctuaryEvent,
} from '../state/sanctuary/connection.js';
import { enqueueTurn, flushOutbox, outboxStore } from '../state/sanctuary/outboxModel.js';
import { loadProgramSession, sessionStore } from '../state/sanctuary/sessionModel.js';
import { syncFeedTuningFromSanctuary } from '../state/feedStore.js';
import { createProgramMessageId, createUserMessageId } from '../state/sanctuary/types.js';

const VOICE_CALL_SVG = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"></path></svg>`;
const GALLERY_SVG = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline></svg>`;
const QUEST_SVG = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"></path></svg>`;
const DATABANK_SVG = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="12 2 2 7 12 12 22 7 12 2"></polygon><polyline points="2 17 12 22 22 17"></polyline><polyline points="2 12 12 17 22 12"></polyline></svg>`;
const PORTRAIT_SVG = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"></path><circle cx="12" cy="13" r="4"></circle></svg>`;
const ATTACH_SVG = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"></path></svg>`;
const IMPERSONATE_SVG = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"></path><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"></path></svg>`;
const SEND_SVG = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>`;
const STOP_SVG = `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="5" y="5" width="14" height="14" rx="2"></rect></svg>`;

/**
 * Mount the Sanctuary AI companion thread using classic dark obsidian-and-glass chrome,
 * scoped Program theme tokens, HITL tool approval cards, streaming portraits,
 * Kokoro voice calls, offline outbox queuing, and user-bubble Fediverse sharing.
 */
export function mountProgramThread(containerEl, {
  programId,
  sessionId = 'default',
  initialDraft = '',
  onBack = null,
  onOpenCompose = null,
  onProgramChanged = null,
} = {}) {
  const doc = globalThis.document;
  containerEl.replaceChildren();

  let currentProgramId = programId || connectionStore.get().activeProgram || 'sebile';
  let currentSessionId = sessionId || 'default';
  let currentTemperature = 0.95;
  let selectedModel = '';
  let activeUserName = 'User';
  let activeDisplayName = currentProgramId;
  let attachedMediaPath = null;
  let attachedMime = null;
  let attachedFilename = '';
  let attachedSharedPost = null;
  let generating = false;
  let abortController = null;
  let activeAudio = null;
  let activeSpeakBtn = null;
  let destroyed = false;
  let pinnedToBottom = true;
  let needsInitialScroll = true;
  let lastSessionScrollKey = `${currentProgramId}:${currentSessionId}`;

  const root = doc.createElement('section');
  root.id = 'app-container';
  root.className = 'sanctuary-thread-view';

  // Classic Sanctuary Header
  const header = doc.createElement('header');
  const titleArea = doc.createElement('div');
  titleArea.className = 'header-title-area';

  if (typeof onBack === 'function') {
    const backBtn = doc.createElement('button');
    backBtn.type = 'button';
    backBtn.className = 'back-nav-btn sanctuary-back-btn';
    backBtn.setAttribute('aria-label', 'Back to Messages');
    backBtn.textContent = '←';
    backBtn.addEventListener('click', () => onBack());
    titleArea.appendChild(backBtn);
  }

  const h1 = doc.createElement('h1');
  h1.className = 'sr-only';
  h1.textContent = `Sanctuary — ${currentProgramId}`;

  const headerStatus = doc.createElement('div');
  headerStatus.className = 'header-status';

  const moodHeart = createMoodHeart({ programName: currentProgramId });
  const statusText = doc.createElement('span');
  statusText.id = 'header-status-text';
  headerStatus.append(moodHeart.buttonEl, statusText);
  titleArea.append(h1, headerStatus);

  const headerActions = doc.createElement('div');
  headerActions.className = 'header-actions';

  const voiceBtn = doc.createElement('button');
  voiceBtn.type = 'button';
  voiceBtn.className = 'pokeball-btn';
  voiceBtn.setAttribute('aria-label', 'Voice Call');
  voiceBtn.title = 'Voice Call';
  voiceBtn.innerHTML = VOICE_CALL_SVG;
  voiceBtn.addEventListener('click', () => {
    const state = sessionStore.get();
    const conn = connectionStore.get();
    const summary = conn.programs.find((p) => p.id === currentProgramId);
    const displayName = state.characterName || summary?.name || currentProgramId;
    openVoiceCallOverlay({
      programId: currentProgramId,
      programName: displayName,
      sessionId: currentSessionId,
      model: selectedModel,
      onSaved: () => refreshSession(),
    });
  });

  const galleryBtn = doc.createElement('button');
  galleryBtn.type = 'button';
  galleryBtn.className = 'gallery-btn';
  galleryBtn.setAttribute('aria-label', 'Image Gallery');
  galleryBtn.title = 'Image Gallery';
  galleryBtn.innerHTML = GALLERY_SVG;
  galleryBtn.addEventListener('click', () => openGallery(currentProgramId, activeDisplayName));

  const questBtn = doc.createElement('button');
  questBtn.type = 'button';
  questBtn.className = 'quest-btn';
  questBtn.setAttribute('aria-label', 'Quest Log');
  questBtn.title = 'Quest Log';
  questBtn.innerHTML = QUEST_SVG;
  questBtn.addEventListener('click', () => {
    openQuestModal({
      sessionId: currentSessionId,
      onQuestCompleted: () => refreshSession(),
    });
  });

  const databankBtn = doc.createElement('button');
  databankBtn.type = 'button';
  databankBtn.className = 'databank-btn';
  databankBtn.setAttribute('aria-label', 'Memory / Knowledge');
  databankBtn.title = 'Memory / Knowledge';
  databankBtn.innerHTML = DATABANK_SVG;
  databankBtn.addEventListener('click', () => {
    const state = sessionStore.get();
    const conn = connectionStore.get();
    const summary = conn.programs.find((p) => p.id === currentProgramId);
    const displayName = state.characterName || summary?.name || currentProgramId;
    openKnowledgeModal({
      programId: currentProgramId,
      programName: displayName,
      sessionId: currentSessionId,
      userName: activeUserName,
      initialTab: 'upload',
    });
  });

  headerActions.append(voiceBtn, questBtn, galleryBtn, databankBtn);
  header.append(titleArea, headerActions);

  // Offline / Queued banner host
  const statusHost = doc.createElement('div');
  statusHost.className = 'sanctuary-offline-banner-host';

  // Chat stream container
  const chatContainer = doc.createElement('div');
  chatContainer.id = 'chat-container';
  chatContainer.className = 'sanctuary-chat-container';
  const bottomSentinel = doc.createElement('div');
  bottomSentinel.id = 'bottom-sentinel';
  chatContainer.appendChild(bottomSentinel);

  function isNearBottom() {
    const scrollH = Number(chatContainer.scrollHeight || 0);
    const clientH = Number(chatContainer.clientHeight || 0);
    const scrollT = Number(chatContainer.scrollTop || 0);
    return scrollH - scrollT - clientH <= 64;
  }

  function scrollToBottom(force = false) {
    if (destroyed) return;
    if (!force && !pinnedToBottom) return;
    const apply = () => {
      if (destroyed) return;
      if (!force && !pinnedToBottom) return;
      chatContainer.scrollTop = chatContainer.scrollHeight || 0;
    };
    apply();
    if (typeof globalThis.requestAnimationFrame === 'function') {
      globalThis.requestAnimationFrame(apply);
    }
  }

  const onChatScroll = () => {
    pinnedToBottom = isNearBottom();
  };
  const onChatMediaLoad = () => {
    scrollToBottom(false);
  };
  chatContainer.addEventListener('scroll', onChatScroll, { passive: true });
  chatContainer.addEventListener('load', onChatMediaLoad, true);

  let chatResizeObserver = null;
  if (typeof globalThis.ResizeObserver === 'function') {
    chatResizeObserver = new globalThis.ResizeObserver(() => {
      scrollToBottom(false);
    });
    chatResizeObserver.observe(chatContainer);
  }

  // Attachment preview strip
  const previewArea = doc.createElement('div');
  previewArea.id = 'preview-area';
  previewArea.className = 'thread-attachment-strip';
  previewArea.hidden = true;

  // Classic pill input bar
  const inputArea = doc.createElement('form');
  inputArea.id = 'input-area';
  inputArea.className = 'sanctuary-input-area';

  const inputWrapper = doc.createElement('div');
  inputWrapper.className = 'input-wrapper';

  const fileInputId = 'sanctuary-thread-file';
  const attachBtn = doc.createElement('button');
  attachBtn.type = 'button';
  attachBtn.className = 'attach-btn';
  attachBtn.setAttribute('aria-label', 'Attach Image or Video');
  attachBtn.title = 'Attach Image or Video';
  attachBtn.innerHTML = ATTACH_SVG;

  const fileInput = doc.createElement('input');
  fileInput.type = 'file';
  fileInput.id = fileInputId;
  fileInput.accept = 'image/*,video/*,audio/*';
  fileInput.className = 'sr-only';
  fileInput.hidden = true;
  attachBtn.addEventListener('click', () => fileInput.click());

  const impersonateBtn = doc.createElement('button');
  impersonateBtn.type = 'button';
  impersonateBtn.id = 'auto-generate-user-btn';
  impersonateBtn.className = 'icon-btn';
  impersonateBtn.style.cssText = 'margin-left: -6px; margin-right: 8px; flex-shrink: 0;';
  impersonateBtn.setAttribute('aria-label', 'Auto-Generate Response');
  impersonateBtn.title = 'Auto-Generate Response';
  impersonateBtn.innerHTML = IMPERSONATE_SVG;

  const textareaLbl = doc.createElement('label');
  textareaLbl.setAttribute('for', 'user-input');
  textareaLbl.className = 'sr-only';
  textareaLbl.textContent = 'Message Program';

  const textarea = doc.createElement('textarea');
  textarea.id = 'user-input';
  textarea.className = 'sanctuary-user-input';
  textarea.rows = 1;
  textarea.placeholder = `Ask ${currentProgramId}`;
  if (initialDraft) textarea.value = initialDraft;

  const supportsFieldSizing = Boolean(globalThis.CSS?.supports?.('field-sizing', 'content'));

  function syncComposerHeight() {
    inputWrapper.classList.toggle('has-unsent-text', textarea.value.trim().length > 0);
    if (supportsFieldSizing) return;
    textarea.style.overflowY = 'hidden';
    textarea.style.height = 'auto';
    const rawScroll = textarea.scrollHeight || 24;
    const measured = textarea.value ? Math.max(24, Math.min(150, rawScroll)) : 24;
    textarea.style.height = `${measured}px`;
    textarea.style.overflowY = rawScroll > 150 ? 'auto' : 'hidden';
  }

  const inputControls = doc.createElement('div');
  inputControls.className = 'input-controls';

  const portraitBtn = doc.createElement('button');
  portraitBtn.type = 'button';
  portraitBtn.id = 'generate-portrait-btn';
  portraitBtn.className = 'icon-btn';
  portraitBtn.setAttribute('aria-label', 'Generate Image');
  portraitBtn.title = 'Generate Image';
  portraitBtn.innerHTML = PORTRAIT_SVG;

  const sendBtn = doc.createElement('button');
  sendBtn.type = 'submit';
  sendBtn.id = 'send-btn';
  sendBtn.className = 'send-btn';
  sendBtn.setAttribute('aria-label', 'Send');
  sendBtn.title = 'Send';
  sendBtn.innerHTML = SEND_SVG;

  const stopBtn = doc.createElement('button');
  stopBtn.type = 'button';
  stopBtn.id = 'stop-btn';
  stopBtn.className = 'stop-btn';
  stopBtn.setAttribute('aria-label', 'Stop Generation');
  stopBtn.title = 'Stop Generation';
  stopBtn.innerHTML = STOP_SVG;
  stopBtn.hidden = true;

  inputControls.append(portraitBtn, sendBtn, stopBtn);
  inputWrapper.append(attachBtn, fileInput, impersonateBtn, textareaLbl, textarea, inputControls);
  inputArea.appendChild(inputWrapper);

  root.append(header, statusHost, chatContainer, previewArea, inputArea);
  containerEl.appendChild(root);

  function syncPlaceholder() {
    textarea.placeholder = attachedSharedPost
      ? 'Add a message or press Enter to send...'
      : `Ask ${activeDisplayName}`;
  }

  function renderAttachmentPreview() {
    previewArea.replaceChildren();
    if (!attachedMediaPath && !attachedSharedPost) {
      previewArea.hidden = true;
      return;
    }
    previewArea.hidden = false;

    if (attachedSharedPost) {
      previewArea.appendChild(
        createSharedPostEmbedCard(attachedSharedPost, {
          onRemove: () => {
            attachedSharedPost = null;
            renderAttachmentPreview();
            syncPlaceholder();
          },
        })
      );
    }

    if (attachedMediaPath) {
      const item = doc.createElement('div');
      item.className = 'preview-item';

      if (attachedMime?.startsWith('image/')) {
        const thumb = doc.createElement('img');
        thumb.src = resolveSanctuaryMediaUrl(attachedMediaPath);
        thumb.alt = attachedFilename || 'Attachment preview';
        item.appendChild(thumb);
      } else {
        const tag = doc.createElement('span');
        tag.className = 'preview-file-badge';
        tag.textContent = attachedFilename || attachedMediaPath;
        item.appendChild(tag);
      }

      const removeBtn = doc.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'remove-preview';
      removeBtn.setAttribute('aria-label', 'Remove attachment');
      removeBtn.textContent = '×';
      removeBtn.addEventListener('click', () => {
        attachedMediaPath = null;
        attachedMime = null;
        attachedFilename = '';
        renderAttachmentPreview();
      });
      item.appendChild(removeBtn);
      previewArea.appendChild(item);
    }
  }

  function setBusy(val) {
    generating = Boolean(val);
    moodHeart.setGeneratingPulse(generating);
    sendBtn.hidden = generating;
    stopBtn.hidden = !generating;
    textarea.disabled = generating;
  }

  function startInlineEdit(msg, bubble) {
    if (!bubble || bubble.classList.contains('editing')) return;
    bubble.classList.add('editing');
    const textDiv = bubble.querySelector('.message-text');
    const original = msg.shared_post
      ? String(msg.user_note ?? '')
      : (bubble.dataset.rawText ?? msg.text ?? '');

    const ta = doc.createElement('textarea');
    ta.className = 'edit-textarea';
    ta.rows = 3;
    ta.value = original;

    const btnRow = doc.createElement('div');
    btnRow.className = 'edit-btn-group';
    const cancelBtn = doc.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'edit-btn edit-cancel-btn';
    cancelBtn.textContent = 'Cancel';
    const saveBtn = doc.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'edit-btn edit-save-btn';
    saveBtn.textContent = 'Save';

    btnRow.append(cancelBtn, saveBtn);
    bubble.replaceChildren(ta, btnRow);

    cancelBtn.addEventListener('click', () => {
      bubble.classList.remove('editing');
      void refreshSession();
    });
    saveBtn.addEventListener('click', async () => {
      const nextText = ta.value;
      saveBtn.disabled = true;
      try {
        if (msg.role === 'user') {
          await editTurn({
            session_id: currentSessionId,
            msg_id: msg.id,
            new_text: nextText,
            model: selectedModel || undefined,
          });
        } else {
          await updateMessageText({
            session_id: currentSessionId,
            msg_id: msg.id,
            new_text: nextText,
          });
        }
        bubble.classList.remove('editing');
        await refreshSession();
      } catch (err) {
        showAlert('Update Failed', err?.message || 'Unable to save edited message.');
      } finally {
        saveBtn.disabled = false;
      }
    });
    if (textDiv) textDiv.remove();
  }

  async function handleSpeak(msg, btn) {
    if (activeSpeakBtn === btn && activeAudio) {
      activeAudio.pause();
      activeSpeakBtn = null;
      return;
    }
    activeAudio?.pause?.();
    activeSpeakBtn = btn;
    const res = await synthesizeSpeech(msg.id, msg.text || '');
    if (res?.audio_url) {
      activeAudio = new globalThis.Audio(resolveSanctuaryMediaUrl(res.audio_url));
      activeAudio.onended = () => {
        activeSpeakBtn = null;
      };
      await activeAudio.play?.();
    }
  }

  function openGallery(targetProgramId = currentProgramId, targetProgramName = '') {
    const conn = connectionStore.get();
    const progId = targetProgramId || currentProgramId;
    const summary = conn.programs.find((p) => p.id === progId);
    const resolvedName = targetProgramName || (progId === currentProgramId ? activeDisplayName : '') || summary?.name || progId;
    openProgramGalleryModal({
      programId: progId,
      programName: resolvedName,
      sessionId: currentSessionId,
      onOpenCompose,
      onRefreshHistory: () => refreshSession(),
    });
  }

  function openRecentMedia(targetProgramId = currentProgramId, targetProgramName = '') {
    const conn = connectionStore.get();
    const progId = targetProgramId || currentProgramId;
    const summary = conn.programs.find((p) => p.id === progId);
    const resolvedName = targetProgramName || (progId === currentProgramId ? activeDisplayName : '') || summary?.name || progId;
    void openLatestProgramMedia({
      programId: progId,
      programName: resolvedName,
      sessionId: currentSessionId,
      onOpenCompose,
      onRefreshHistory: () => refreshSession(),
    });
  }

  function buildRowContext() {
    const state = sessionStore.get();
    return {
      programId: currentProgramId,
      sessionId: currentSessionId,
      programName: state.characterName || currentProgramId,
      theme: state.theme,
      cacheBuster: getProgramAvatarVersion(currentProgramId),
      getAvatarVersion: (sid) => getProgramAvatarVersion(sid || currentProgramId),
      onOpenCompose,
      onOpenAvatarMedia: (speakerId, speakerName) => openRecentMedia(speakerId || currentProgramId, speakerName),
      onOpenGallery: (speakerId, speakerName) => openGallery(speakerId || currentProgramId, speakerName),
      onRefreshHistory: () => refreshSession(),
      onReroll: async (msg) => {
        setBusy(true);
        try {
          await editTurn({
            session_id: currentSessionId,
            msg_id: msg.id,
            new_text: null,
            model: selectedModel || undefined,
          });
          await refreshSession();
        } finally {
          setBusy(false);
        }
      },
      onEdit: (msg, _row, bubble) => startInlineEdit(msg, bubble),
      onDelete: async (msg) => {
        await deleteMessage({ session_id: currentSessionId, msg_id: msg.id });
        await refreshSession();
      },
      onSpeak: (msg, btn) => void handleSpeak(msg, btn),
    };
  }

  function renderSnapshot() {
    if (destroyed) return;
    const state = sessionStore.get();
    const conn = connectionStore.get();
    const summary = conn.programs.find((p) => p.id === currentProgramId);

    const sessionKey = `${state.activeProgramId || currentProgramId}:${state.activeSessionId || currentSessionId}`;
    if (sessionKey !== lastSessionScrollKey) {
      lastSessionScrollKey = sessionKey;
      pinnedToBottom = true;
      needsInitialScroll = true;
    }

    const displayName = state.characterName || summary?.name || currentProgramId;
    activeDisplayName = displayName;
    h1.textContent = `Sanctuary — ${displayName}`;
    syncPlaceholder();

    if (conn.mode === 'online') {
      statusText.textContent = '';
    } else if (conn.mode === 'offline') {
      statusText.textContent = 'Offline';
    } else {
      statusText.textContent = '';
    }

    const theme = state.theme || summary?.theme || summary?.accent_color;
    applyScopedProgramTheme(root, theme);
    applyRootProgramTheme(theme);
    moodHeart.updateMood(state.moodState, state.inversionActive, state.inversionState, displayName, state.messages);

    const outboxForSession = outboxStore.get().items.filter(
      (it) => it.programId === currentProgramId && it.sessionId === currentSessionId
    );

    if (conn.mode === 'offline') {
      const suffix = outboxForSession.length > 0 ? ` • ${outboxForSession.length} queued` : '';
      statusHost.replaceChildren(
        createOfflineNotice({
          variant: 'offline',
          message: `Sanctuary Offline • Cached history${suffix}`,
        })
      );
    } else if (outboxForSession.length > 0) {
      statusHost.replaceChildren(
        createOfflineNotice({
          variant: 'info',
          message: `Replaying ${outboxForSession.length} queued turn(s)...`,
          actionLabel: 'Flush',
          onAction: () => void flushOutbox().then(() => refreshSession()),
        })
      );
    } else {
      statusHost.replaceChildren();
    }

    const reconcileRes = reconcileChat(chatContainer, state.messages, buildRowContext());

    chatContainer.querySelector('#active-thought-bubble')?.remove();
    if (conn.mode === 'online' && summary?.idle_thought && !generating) {
      chatContainer.insertBefore(createIdleThoughtRow(summary.idle_thought, displayName), bottomSentinel);
    }

    if (needsInitialScroll) {
      scrollToBottom(true);
      if (!state.loading) {
        needsInitialScroll = false;
      }
    } else if (reconcileRes.changed && pinnedToBottom) {
      scrollToBottom(false);
    }
  }

  async function refreshSession() {
    if (destroyed) return;
    await loadProgramSession(currentProgramId, currentSessionId);
  }

  async function refreshModelsAndConfig() {
    if (connectionStore.get().mode !== 'online') return;
    try {
      const [modelsData, configData] = await Promise.all([
        fetchModels().catch(() => null),
        fetchRuntimeConfig().catch(() => null),
      ]);
      if (destroyed) return;
      if (modelsData) {
        currentTemperature = modelsData?.status?.temperature ?? 0.95;
        selectedModel = selectedModel || modelsData?.default || modelsData?.models?.[0]?.value || '';
      }
      if (configData?.active_user) {
        activeUserName = configData.active_user;
      }
      if (configData?.program_moods) {
        moodHeart.setMoodMetadata(configData.program_moods);
      }
    } catch {
      // Non-fatal in dormant/offline states
    }
  }

  function attachSharedPost(post) {
    attachedSharedPost = normalizeSharedPostCard(post);
    renderAttachmentPreview();
    syncPlaceholder();
    textarea.focus?.();
  }

  function switchProgram(nextProgramId, nextSessionId = 'default', draft = '') {
    if (nextProgramId) currentProgramId = nextProgramId;
    if (nextSessionId) currentSessionId = nextSessionId;
    pinnedToBottom = true;
    needsInitialScroll = true;
    lastSessionScrollKey = `${currentProgramId}:${currentSessionId}`;
    if (draft) textarea.value = String(draft);
    syncComposerHeight();
    attachedMediaPath = null;
    attachedMime = null;
    attachedFilename = '';
    attachedSharedPost = null;
    renderAttachmentPreview();
    syncPlaceholder();
    activeAudio?.pause?.();
    activeSpeakBtn = null;
    void onProgramChanged?.(currentProgramId, currentSessionId);
    void refreshSession();
  }

  async function submitTurn() {
    if (generating) return;
    const text = textarea.value.trim();
    const mediaPath = attachedMediaPath;
    const mime = attachedMime;
    const sharedPost = attachedSharedPost;
    const conn = connectionStore.get();

    if (!text && !mediaPath && !sharedPost) {
      if (conn.mode !== 'online' || !chatContainer.querySelector(LIVE_ROW_SELECTOR)) return;
      pinnedToBottom = true;
      setBusy(true);
      const { row: typingRow, bubble: typingBubble } = createTypingIndicatorRow(currentProgramId, buildRowContext());
      chatContainer.insertBefore(typingRow, bottomSentinel);
      scrollToBottom(true);
      const stopMonitor = startTurnToolMonitor({ sessionId: currentSessionId, chatContainer, typingBubble });
      abortController = new AbortController();
      try {
        const contData = await continueGeneration(
          { session_id: currentSessionId, model: selectedModel || undefined },
          { signal: abortController.signal }
        );
        if (contData?.message?.tool_calls?.some((tc) => tc?.name === 'tune_feed_algorithm')) {
          void syncFeedTuningFromSanctuary();
        }
        await refreshSession();
      } finally {
        stopMonitor();
        typingRow.remove();
        setBusy(false);
      }
      return;
    }

    const userMsgId = createUserMessageId();
    const outboundMessage = sharedPost ? formatSharedPostForLlm(sharedPost, text) : text;
    textarea.value = '';
    syncComposerHeight();
    attachedMediaPath = null;
    attachedMime = null;
    attachedFilename = '';
    attachedSharedPost = null;
    renderAttachmentPreview();
    syncPlaceholder();

    if (conn.mode !== 'online') {
      await enqueueTurn({
        programId: currentProgramId,
        sessionId: currentSessionId,
        message: outboundMessage,
        mediaPath,
        imageMime: mime,
        model: selectedModel || null,
        msgId: userMsgId,
        ...(sharedPost ? { sharedPost, userNote: text } : {}),
      });
      await refreshSession();
      return;
    }

    const optimisticUserMsg = {
      id: userMsgId,
      role: 'user',
      text: outboundMessage,
      media: mediaPath ? [{ url: mediaPath, type: mime?.startsWith('video/') ? 'video' : 'image' }] : [],
      timestamp: Date.now() / 1000,
      ...(sharedPost ? { shared_post: sharedPost, user_note: text } : {}),
    };

    pinnedToBottom = true;
    setBusy(true);
    sessionStore.set((prev) => ({
      messages: [
        ...(Array.isArray(prev.messages) ? prev.messages : []).filter((m) => m?.id !== userMsgId),
        optimisticUserMsg,
      ],
      generating: true,
    }));

    const { row: typingRow, bubble: typingBubble } = createTypingIndicatorRow(currentProgramId, buildRowContext());
    chatContainer.insertBefore(typingRow, bottomSentinel);
    scrollToBottom(true);
    const stopMonitor = startTurnToolMonitor({ sessionId: currentSessionId, chatContainer, typingBubble });
    abortController = new AbortController();

    try {
      const data = await sendChat(
        {
          session_id: currentSessionId,
          msg_id: userMsgId,
          message: outboundMessage,
          image_mime: mime,
          media_path: mediaPath,
          model: selectedModel || undefined,
          ...(sharedPost ? { shared_post: sharedPost, user_note: text } : {}),
        },
        { signal: abortController.signal }
      );
      typingRow.remove();
      if (data?.message && !data.cancelled) {
        const msgObj = data.message;
        sessionStore.set((prev) => ({
          messages: [
            ...(Array.isArray(prev.messages) ? prev.messages : []).filter((m) => m?.id !== msgObj.id),
            msgObj,
          ],
        }));
        scrollToBottom(false);
      }
      if (data?.state) {
        moodHeart.updateMood(data.state, data.inversion_active, data.inversion_state);
      }
      if (data?.message?.tool_calls?.some((tc) => tc?.name === 'tune_feed_algorithm')) {
        void syncFeedTuningFromSanctuary();
      }
      await refreshSession();
    } catch {
      typingRow.remove();
      await refreshSession().catch(() => {});
    } finally {
      stopMonitor();
      setBusy(false);
      sessionStore.set({ generating: false });
      abortController = null;
    }
  }

  inputArea.addEventListener('submit', (e) => {
    e.preventDefault();
    void submitTurn();
  });

  textarea.addEventListener('input', syncComposerHeight);

  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void submitTurn();
    }
  });

  stopBtn.addEventListener('click', () => {
    abortController?.abort();
    void cancelChat(currentSessionId).catch(() => {});
  });

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    if (!file || connectionStore.get().mode !== 'online') return;
    previewArea.hidden = false;
    previewArea.textContent = `Uploading ${file.name}...`;
    try {
      const res = await uploadSanctuaryMedia(file);
      attachedMediaPath = res.file_path;
      attachedMime = file.type || 'image/png';
      attachedFilename = file.name;
      renderAttachmentPreview();
    } catch (err) {
      previewArea.textContent = err?.message || 'Upload failed';
    } finally {
      fileInput.value = '';
    }
  });

  impersonateBtn.addEventListener('click', async () => {
    if (connectionStore.get().mode !== 'online' || generating) return;
    impersonateBtn.disabled = true;
    try {
      const res = await generateUserImpersonation({
        session_id: currentSessionId,
        model: selectedModel || undefined,
      });
      if (res?.message) {
        textarea.value = res.message;
        syncComposerHeight();
      }
    } finally {
      impersonateBtn.disabled = false;
    }
  });

  portraitBtn.addEventListener('click', async () => {
    if (connectionStore.get().mode !== 'online' || generating) return;
    pinnedToBottom = true;
    setBusy(true);
    try {
      await streamPortraitGeneration(chatContainer, {
        sessionId: currentSessionId,
        prompt: textarea.value.trim(),
        speakerId: currentProgramId,
        msgId: createProgramMessageId(),
        ctx: buildRowContext(),
      });
      await refreshSession();
      scrollToBottom(true);
    } finally {
      setBusy(false);
    }
  });

  const unsubSession = sessionStore.subscribe(renderSnapshot);
  const unsubConn = connectionStore.subscribe(renderSnapshot);
  const unsubOutbox = outboxStore.subscribe(renderSnapshot);
  const offOnline = onSanctuaryEvent('sanctuary:online', () => {
    void refreshModelsAndConfig();
    void refreshSession();
  });

  void refreshModelsAndConfig();
  void refreshSession();

  syncComposerHeight();

  return {
    rootEl: root,
    setDraftText(text) {
      textarea.value = String(text || '');
      syncComposerHeight();
    },
    attachSharedPost,
    switchProgram,
    refresh: refreshSession,
    refreshModels: refreshModelsAndConfig,
    setTemperature(nextTemp) {
      if (Number.isFinite(Number(nextTemp))) currentTemperature = Number(nextTemp);
    },
    getCurrentProgramId: () => currentProgramId,
    getCurrentSessionId: () => currentSessionId,
    getTemperature: () => currentTemperature,
    getActiveUser: () => activeUserName,
    destroy() {
      destroyed = true;
      abortController?.abort();
      activeAudio?.pause?.();
      chatResizeObserver?.disconnect?.();
      chatContainer.removeEventListener('scroll', onChatScroll);
      chatContainer.removeEventListener('load', onChatMediaLoad, true);
      unsubSession();
      unsubConn();
      unsubOutbox();
      offOnline();
    },
  };
}
