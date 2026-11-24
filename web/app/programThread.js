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
  findLiveRowById,
  formatSharedPostForLlm,
  normalizeSharedPostCard,
  parseInlineSharedPostFallback,
  reconcileChat,
  syncSpeakButtonVisual,
} from '../components/sanctuary/MessageRow.js';
import { createMoodHeart } from '../components/sanctuary/MoodHeart.js';
import {
  openLatestProgramMedia,
  openProgramGalleryModal,
  streamPortraitGeneration,
} from '../components/sanctuary/PortraitGrid.js';
import { openQuestModal } from '../components/sanctuary/QuestModal.js';
import { showAlert } from '../components/sanctuary/SanctuaryDialog.js';
import { promptUnlockVault } from '../components/sanctuary/SettingsModal.js';
import { startTurnToolMonitor } from '../components/sanctuary/ToolApprovalCard.js';
import { openVoiceCallOverlay } from '../components/sanctuary/VoiceCallOverlay.js';
import {
  cancelChat,
  continueGeneration,
  deleteMessage,
  editTurn,
  fetchGenerationStatus,
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
import { enqueueTurn, flushOutbox, outboxStore, removeQueuedTurn } from '../state/sanctuary/outboxModel.js';
import { loadProgramSession, sessionStore } from '../state/sanctuary/sessionModel.js';
import { syncFeedTuningFromSanctuary } from '../state/feedStore.js';
import { executeBrowserAgentCommand } from '../state/browserStore.js';
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
  onClientAction = null,
  onBrowserCommand = null,
} = {}) {
  const doc = globalThis.document;
  containerEl.replaceChildren();

  const initConn = connectionStore.get();
  let hasExplicitProgram = Boolean(programId);
  let currentProgramId = programId || initConn.activeProgram || initConn.programs?.[0]?.id || '';
  let currentSessionId = sessionId || 'default';
  let currentTemperature = 0.95;
  let selectedModel = '';
  let activeUserName = 'User';
  let activeDisplayName = currentProgramId || 'Sanctuary';
  let attachedFile = null;
  let attachedPreviewUrl = '';
  let attachedMediaPath = null;
  let attachedMime = null;
  let attachedFilename = '';
  let attachedSharedPost = null;
  let generating = false;
  let abortController = null;
  let activeTurnPromise = null;
  let activeCancelPromise = null;
  let reattachedMonitor = null;
  let turnCounter = 0;
  let activeAudio = null;
  let activeSpeakBtn = null;
  let activeSpeakMsgId = '';
  let speakState = 'idle';
  let speakAbortController = null;
  let speakRequestSeq = 0;
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
  h1.textContent = `Sanctuary — ${currentProgramId || 'Chat'}`;

  const headerStatus = doc.createElement('div');
  headerStatus.className = 'header-status';

  const moodHeart = createMoodHeart({ programName: currentProgramId || 'Sanctuary' });
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
    if (connectionStore.get().mode === 'online' && sessionStore.get().vaultLocked) {
      textarea.placeholder = 'Unlock .kdbx vault to continue…';
      return;
    }
    textarea.placeholder = attachedSharedPost
      ? 'Add a message or press Enter to send...'
      : `Ask ${activeDisplayName}`;
  }

  function formatAttachmentSize(bytes) {
    const n = Number(bytes);
    if (!Number.isFinite(n) || n <= 0) return 'Ready to send';
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  }

  function clearStagedAttachment({ revoke = true } = {}) {
    if (revoke && attachedPreviewUrl && typeof globalThis.URL?.revokeObjectURL === 'function' && attachedPreviewUrl.startsWith('blob:')) {
      try {
        globalThis.URL.revokeObjectURL(attachedPreviewUrl);
      } catch {
        // Ignore revoke errors
      }
    }
    attachedFile = null;
    attachedPreviewUrl = '';
    attachedMediaPath = null;
    attachedMime = null;
    attachedFilename = '';
    if (fileInput) {
      fileInput.value = '';
    }
  }

  function renderAttachmentPreview() {
    previewArea.replaceChildren();
    const hasMedia = Boolean(attachedFile || attachedMediaPath);
    if (!hasMedia && !attachedSharedPost) {
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

    if (hasMedia) {
      const item = doc.createElement('div');
      item.className = 'preview-item';

      if ((attachedMime || '').startsWith('image/')) {
        const thumb = doc.createElement('img');
        thumb.className = 'preview-item-thumb';
        thumb.src = attachedPreviewUrl || resolveSanctuaryMediaUrl(attachedMediaPath);
        thumb.alt = attachedFilename || 'Attachment preview';
        item.appendChild(thumb);
      } else {
        const tag = doc.createElement('span');
        tag.className = 'preview-file-badge';
        tag.textContent = attachedFilename || attachedMediaPath || 'Attachment';
        item.appendChild(tag);
      }

      const meta = doc.createElement('div');
      meta.className = 'preview-item-meta';
      const nameEl = doc.createElement('span');
      nameEl.className = 'preview-item-name';
      nameEl.textContent = attachedFilename || 'Pasted image';
      const subEl = doc.createElement('span');
      subEl.className = 'preview-item-sub';
      subEl.textContent = formatAttachmentSize(attachedFile?.size);
      meta.append(nameEl, subEl);
      item.appendChild(meta);

      const removeBtn = doc.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'remove-preview';
      removeBtn.setAttribute('aria-label', 'Remove attachment');
      removeBtn.textContent = '×';
      removeBtn.addEventListener('click', () => {
        clearStagedAttachment();
        renderAttachmentPreview();
      });
      item.appendChild(removeBtn);
      previewArea.appendChild(item);
    }
  }

  function setBusy(val) {
    generating = Boolean(val);
    const locked = connectionStore.get().mode === 'online' && Boolean(sessionStore.get().vaultLocked);
    moodHeart.setGeneratingPulse(generating);
    sendBtn.hidden = generating;
    stopBtn.hidden = !generating;
    textarea.disabled = generating || locked;
    sendBtn.disabled = locked;
    attachBtn.disabled = locked;
    portraitBtn.disabled = locked;
    impersonateBtn.disabled = locked;
  }

  function stopReattachedMonitor() {
    if (!reattachedMonitor) return;
    const active = reattachedMonitor;
    reattachedMonitor = null;
    active.stop();
  }

  function dispatchClientActionOnce(dispatchedKeys, action) {
    if (destroyed || typeof onClientAction !== 'function' || !action?.type) return;
    const key = `${action.type}:${action.url || ''}:${Boolean(action.split)}`;
    if (dispatchedKeys.has(key)) return;
    dispatchedKeys.add(key);
    onClientAction(action);
  }

  function handleCompletedTurnTools(res, dispatchedKeys = new Set()) {
    const calls = Array.isArray(res?.message?.tool_calls)
      ? res.message.tool_calls
      : (Array.isArray(res?.tool_calls) ? res.tool_calls : []);
    if (calls.some((tc) => tc?.name === 'tune_feed_algorithm')) {
      void syncFeedTuningFromSanctuary();
    }
    for (const tc of calls) {
      if (tc?.type === 'response' || tc?.type === 'result') continue;
      if (tc?.name === 'open_in_browser' && tc?.args?.url) {
        dispatchClientActionOnce(dispatchedKeys, {
          type: 'open_browser_tab',
          url: String(tc.args.url),
          split: Boolean(tc.args.split),
        });
      }
    }
  }

  function startReattachedMonitor() {
    if (reattachedMonitor || generating || activeTurnPromise || activeCancelPromise || destroyed) return;
    let stopped = false;
    let pollTimer = null;
    const reattachDispatched = new Set();
    pinnedToBottom = true;
    setBusy(true);
    const { row: typingRow, bubble: typingBubble } = createTypingIndicatorRow(currentProgramId, buildRowContext());
    chatContainer.insertBefore(typingRow, bottomSentinel);
    scrollToBottom(true);
    const stopToolMonitor = startTurnToolMonitor({
      sessionId: currentSessionId,
      chatContainer,
      typingBubble,
      onClientAction: (action) => dispatchClientActionOnce(reattachDispatched, action),
      onBrowserCommand: (cmd) =>
        typeof onBrowserCommand === 'function' ? onBrowserCommand(cmd) : executeBrowserAgentCommand(cmd),
    });

    const cleanup = () => {
      if (stopped) return;
      stopped = true;
      if (pollTimer !== null) {
        clearTimeout(pollTimer);
        pollTimer = null;
      }
      stopToolMonitor();
      typingRow.remove();
      if (!activeTurnPromise) {
        setBusy(false);
      }
      if (reattachedMonitor?.stop === cleanup) {
        reattachedMonitor = null;
      }
    };

    const pollStatus = async () => {
      if (stopped || destroyed) return;
      try {
        const res = await fetchGenerationStatus(currentSessionId);
        if (stopped || destroyed) return;
        if (!res?.generating) {
          cleanup();
          sessionStore.set({ generating: false });
          await refreshSession().catch(() => {});
          return;
        }
      } catch {
        // Retry on next interval until backend reports idle or user stops.
      }
      if (!stopped && !destroyed) {
        pollTimer = setTimeout(() => void pollStatus(), 1200);
        pollTimer?.unref?.();
      }
    };

    pollTimer = setTimeout(() => void pollStatus(), 1200);
    pollTimer?.unref?.();
    reattachedMonitor = { stop: cleanup };
  }

  async function stopActiveGeneration() {
    if (activeCancelPromise) return activeCancelPromise;
    const turnToWait = activeTurnPromise;
    const wasReattached = Boolean(reattachedMonitor);
    stopBtn.disabled = true;
    const runCancel = async () => {
      try {
        await cancelChat(currentSessionId, { timeoutMs: 8000 }).catch(() => null);
      } finally {
        if (wasReattached) {
          stopReattachedMonitor();
          sessionStore.set({ generating: false });
        }
      }
    };
    const cancelPromise = runCancel();
    activeCancelPromise = cancelPromise;
    abortController?.abort();
    try {
      await cancelPromise;
      if (turnToWait) {
        await turnToWait.catch(() => null);
      }
      if (wasReattached && !destroyed) {
        await refreshSession().catch(() => {});
      }
    } finally {
      if (activeCancelPromise === cancelPromise) {
        activeCancelPromise = null;
      }
      stopBtn.disabled = false;
    }
  }

  async function withTurnMonitor(speakerId, runFn) {
    stopReattachedMonitor();
    turnCounter += 1;
    pinnedToBottom = true;
    setBusy(true);
    sessionStore.set({ generating: true });
    const turnDispatched = new Set();
    const { row: typingRow, bubble: typingBubble } = createTypingIndicatorRow(speakerId, buildRowContext());
    chatContainer.insertBefore(typingRow, bottomSentinel);
    scrollToBottom(true);
    const stopMonitor = startTurnToolMonitor({
      sessionId: currentSessionId,
      chatContainer,
      typingBubble,
      onClientAction: (action) => dispatchClientActionOnce(turnDispatched, action),
      onBrowserCommand: (cmd) =>
        typeof onBrowserCommand === 'function' ? onBrowserCommand(cmd) : executeBrowserAgentCommand(cmd),
    });
    abortController = new AbortController();

    const execute = (async () => {
      try {
        return await runFn(abortController.signal, typingRow, turnDispatched);
      } finally {
        if (activeCancelPromise) {
          await activeCancelPromise.catch(() => null);
        }
        stopMonitor();
        typingRow.remove();
        setBusy(false);
        sessionStore.set({ generating: false });
        abortController = null;
        if (activeTurnPromise === execute) {
          activeTurnPromise = null;
        }
      }
    })();

    activeTurnPromise = execute;
    return await execute;
  }

  function startInlineEdit(msg, row, bubble, initialDraftText = null) {
    if (!bubble || bubble.classList.contains('editing')) return;
    const targetRow = row || bubble.closest?.('.message-row') || null;
    const originalChildren = [...bubble.childNodes];
    const fallbackShared = !msg.shared_post && msg.role === 'user' ? parseInlineSharedPostFallback(msg.text) : null;
    const activeSharedPost = msg.shared_post || fallbackShared?.sharedPost || null;
    const original = activeSharedPost
      ? String(msg.shared_post ? (msg.user_note ?? '') : (fallbackShared?.userNote ?? ''))
      : (bubble.dataset.rawText ?? msg.text ?? '');

    bubble.classList.add('editing');

    const editForm = doc.createElement('form');
    editForm.className = 'edit-form';
    const editInputId = `edit-msg-${String(msg.id || Date.now()).replace(/[^a-zA-Z0-9_-]/g, '_')}`;

    const taLbl = doc.createElement('label');
    taLbl.setAttribute('for', editInputId);
    taLbl.className = 'sr-only';
    taLbl.textContent = msg.role === 'user' ? 'Edit message' : 'Edit response';

    const ta = doc.createElement('textarea');
    ta.id = editInputId;
    ta.name = 'edited_message';
    ta.className = 'edit-textarea';
    ta.rows = 3;
    ta.value = initialDraftText !== null ? String(initialDraftText) : original;

    const btnRow = doc.createElement('div');
    btnRow.className = 'edit-btn-group';
    const cancelBtn = doc.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'edit-btn edit-cancel-btn';
    cancelBtn.textContent = 'Cancel';
    const saveBtn = doc.createElement('button');
    saveBtn.type = 'submit';
    saveBtn.className = 'edit-btn edit-save-btn';
    saveBtn.textContent = 'Save';

    btnRow.append(cancelBtn, saveBtn);
    editForm.append(taLbl, ta, btnRow);
    bubble.replaceChildren(editForm);

    ta.focus?.();
    ta.setSelectionRange?.(ta.value.length, ta.value.length);

    let saving = false;

    const closeEditor = ({ restoreOriginal = true } = {}) => {
      bubble.classList.remove('editing');
      if (restoreOriginal) {
        bubble.replaceChildren(...originalChildren);
        renderSnapshot();
      } else if (targetRow) {
        targetRow.dataset.contentHash = '';
      }
    };

    const handleCancel = () => {
      if (saving) return;
      closeEditor({ restoreOriginal: true });
    };

    const handleSave = async () => {
      if (saving) return;
      const nextText = ta.value;

      if (nextText === original) {
        closeEditor({ restoreOriginal: true });
        return;
      }
      if (connectionStore.get().mode !== 'online') {
        showAlert('Offline', 'Cannot edit messages while Sanctuary is offline.');
        return;
      }

      saving = true;
      ta.disabled = true;
      saveBtn.disabled = true;
      cancelBtn.disabled = true;
      try {
        await updateMessageText({
          session_id: currentSessionId,
          msg_id: msg.id,
          new_text: nextText,
        });
        if (destroyed) return;
        closeEditor({ restoreOriginal: false });
        sessionStore.set((prev) => ({
          messages: (Array.isArray(prev.messages) ? prev.messages : []).map((m) => {
            if (m?.id !== msg.id) return m;
            if (activeSharedPost) {
              return {
                ...m,
                shared_post: activeSharedPost,
                user_note: nextText,
                text: formatSharedPostForLlm(activeSharedPost, nextText),
              };
            }
            return { ...m, text: nextText };
          }),
        }));
        await refreshSession();
      } catch (err) {
        showAlert('Update Failed', err?.message || 'Unable to save edited message.');
      } finally {
        saving = false;
        ta.disabled = false;
        saveBtn.disabled = false;
        cancelBtn.disabled = false;
      }
    };

    cancelBtn.addEventListener('click', handleCancel);
    editForm.addEventListener('submit', (e) => {
      e.preventDefault();
      void handleSave();
    });
    saveBtn.addEventListener('click', (e) => {
      e.preventDefault();
      void handleSave();
    });
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        handleCancel();
      } else if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        void handleSave();
      }
    });
  }

  function findSpeakBtnByMsgId(msgKey) {
    if (!msgKey) return null;
    const buttons = chatContainer.querySelectorAll('.speak-btn');
    for (const el of buttons) {
      if (el.dataset?.msgId === msgKey) return el;
    }
    return null;
  }

  function stopActiveSpeech() {
    speakRequestSeq += 1;
    if (speakAbortController) {
      speakAbortController.abort();
      speakAbortController = null;
    }
    if (activeAudio) {
      activeAudio.onended = null;
      activeAudio.onerror = null;
      activeAudio.pause?.();
      activeAudio = null;
    }
    if (activeSpeakBtn) {
      syncSpeakButtonVisual(activeSpeakBtn, 'idle');
    }
    for (const el of chatContainer.querySelectorAll('.speak-btn.is-loading, .speak-btn.is-speaking')) {
      syncSpeakButtonVisual(el, 'idle');
    }
    activeSpeakBtn = null;
    activeSpeakMsgId = '';
    speakState = 'idle';
  }

  async function handleSpeak(msg, btn) {
    const msgKey = String(msg?.id || btn?.dataset?.msgId || '');
    if (speakState !== 'idle' && (activeSpeakBtn === btn || (msgKey && activeSpeakMsgId === msgKey))) {
      stopActiveSpeech();
      return;
    }
    stopActiveSpeech();
    const seq = ++speakRequestSeq;
    const controller = typeof globalThis.AbortController === 'function'
      ? new globalThis.AbortController()
      : null;
    speakAbortController = controller;
    activeSpeakBtn = btn;
    activeSpeakMsgId = msgKey;
    speakState = 'loading';
    syncSpeakButtonVisual(btn, 'loading');
    try {
      const res = await synthesizeSpeech(
        msg.id,
        msg.text || '',
        controller ? { signal: controller.signal } : {}
      );
      if (destroyed || seq !== speakRequestSeq) return;
      if (!res?.audio_url) {
        stopActiveSpeech();
        return;
      }
      const audio = new globalThis.Audio(resolveSanctuaryMediaUrl(res.audio_url));
      const liveBtn = (msgKey && findSpeakBtnByMsgId(msgKey)) || btn;
      activeAudio = audio;
      speakAbortController = null;
      activeSpeakBtn = liveBtn;
      speakState = 'playing';
      syncSpeakButtonVisual(liveBtn, 'playing');
      audio.onended = () => {
        if (seq === speakRequestSeq) stopActiveSpeech();
      };
      audio.onerror = () => {
        if (seq === speakRequestSeq) stopActiveSpeech();
      };
      await audio.play?.();
      if (destroyed || seq !== speakRequestSeq) {
        audio.pause?.();
      }
    } catch {
      if (seq === speakRequestSeq) {
        stopActiveSpeech();
      }
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
    const conn = connectionStore.get();
    const summary = conn.programs.find((p) => p.id === currentProgramId);
    const isSessionForCurrentProgram =
      !state.activeProgramId || state.activeProgramId === currentProgramId;
    const resolvedTheme =
      (isSessionForCurrentProgram && state.theme) ||
      summary?.theme ||
      summary?.accent_color ||
      summary?.theme_color ||
      null;
    return {
      programId: currentProgramId,
      sessionId: currentSessionId,
      programName: state.characterName || currentProgramId,
      theme: resolvedTheme,
      getThemeForProgram: (sid) => {
        const tid = sid || currentProgramId;
        if (tid === currentProgramId && resolvedTheme) return resolvedTheme;
        const p = conn.programs.find((x) => x.id === tid);
        return p?.theme || p?.accent_color || p?.theme_color || resolvedTheme;
      },
      cacheBuster: getProgramAvatarVersion(currentProgramId),
      getAvatarVersion: (sid) => getProgramAvatarVersion(sid || currentProgramId),
      hasProgramProfile: (sid) => {
        const tid = sid || currentProgramId;
        if (getProgramAvatarVersion(tid) > 0) return true;
        const p = connectionStore.get().programs.find((x) => x.id === tid);
        return p ? Boolean(p.has_profile) : true;
      },
      onOpenCompose,
      onOpenAvatarMedia: (speakerId, speakerName) => openRecentMedia(speakerId || currentProgramId, speakerName),
      onOpenGallery: (speakerId, speakerName) => openGallery(speakerId || currentProgramId, speakerName),
      onRefreshHistory: () => refreshSession(),
      onReroll: async (msg) => {
        if (connectionStore.get().mode !== 'online') {
          showAlert('Offline', 'Cannot reroll responses while Sanctuary is offline.');
          return;
        }
        if (generating || reattachedMonitor) {
          turnCounter += 1;
          await stopActiveGeneration();
          if (destroyed) return;
        }

        const prevMessages = Array.isArray(sessionStore.get().messages) ? sessionStore.get().messages : [];
        const targetIdx = prevMessages.findIndex((m) => m?.id === msg.id);
        if (targetIdx >= 0) {
          const keptMessages =
            msg.role === 'user'
              ? prevMessages.slice(0, targetIdx + 1)
              : prevMessages.slice(0, targetIdx);
          sessionStore.set({ messages: keptMessages });
        }

        const turnGen = turnCounter + 1;
        let failed = false;
        await withTurnMonitor(msg.sender_id || currentProgramId, async (signal, typingRow, turnDispatched) => {
          try {
            const res = await editTurn(
              {
                session_id: currentSessionId,
                msg_id: msg.id,
                new_text: null,
                model: selectedModel || undefined,
              },
              { signal }
            );
            if (!signal.aborted) {
              if (res?.message && !res?.cancelled) {
                const msgObj = res.message;
                sessionStore.set((prev) => ({
                  messages: [
                    ...(Array.isArray(prev.messages) ? prev.messages : []).filter((m) => m?.id !== msgObj.id),
                    msgObj,
                  ],
                }));
                scrollToBottom(false);
              }
              typingRow.remove();
              handleCompletedTurnTools(res, turnDispatched);
            }
          } catch (err) {
            if (!signal.aborted && err?.name !== 'AbortError' && !err?.isAborted) {
              failed = true;
            }
          }
        });
        if (!destroyed && turnCounter === turnGen) {
          if (failed) {
            sessionStore.set({ messages: prevMessages });
          }
          await refreshSession().catch(() => {});
        }
      },
      onEdit: (msg, row, bubble) => startInlineEdit(msg, row, bubble),
      onDelete: async (msg) => {
        if (!msg?.id) return;
        if (generating) {
          await stopActiveGeneration();
        }
        sessionStore.set((prev) => ({
          messages: (Array.isArray(prev.messages) ? prev.messages : []).filter((m) => m?.id !== msg.id),
        }));
        await removeQueuedTurn(currentProgramId, currentSessionId, msg.id);
        if (connectionStore.get().mode === 'online') {
          try {
            await deleteMessage({ session_id: currentSessionId, msg_id: msg.id });
          } catch (err) {
            if (err?.status !== 404) throw err;
          }
        }
        await refreshSession();
      },
      getSpeakState: (id) => (id && String(id) === activeSpeakMsgId ? speakState : 'idle'),
      onSpeak: (msg, btn) => void handleSpeak(msg, btn),
      onProceedPlan: () => {
        if (generating) return;
        textarea.value = 'Proceed with the implementation plan above.';
        syncComposerHeight();
        void submitTurn();
      },
      onRevisePlan: () => {
        textarea.value = "Let's revise the plan: ";
        syncComposerHeight();
        textarea.focus?.();
      },
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

    if (generating) {
      statusText.textContent = '';
    } else if (conn.mode === 'online') {
      statusText.textContent = '';
    } else if (conn.mode === 'offline') {
      statusText.textContent = 'Offline';
    } else {
      statusText.textContent = '';
    }

    const isSessionForCurrentProgram =
      !state.activeProgramId || state.activeProgramId === currentProgramId;
    const theme =
      (isSessionForCurrentProgram && state.theme) ||
      summary?.theme ||
      summary?.accent_color ||
      summary?.theme_color;
    applyScopedProgramTheme(root, theme);
    applyRootProgramTheme(theme);
    moodHeart.updateMood(state.moodState, state.inversionActive, state.inversionState, displayName, state.messages);

    const outboxForSession = outboxStore.get().items.filter(
      (it) => it.programId === currentProgramId && it.sessionId === currentSessionId
    );

    const locked = conn.mode === 'online' && Boolean(state.vaultLocked);
    textarea.disabled = generating || locked;
    sendBtn.disabled = locked;
    attachBtn.disabled = locked;
    portraitBtn.disabled = locked;
    impersonateBtn.disabled = locked;

    if (generating) {
      statusHost.replaceChildren();
    } else if (locked) {
      statusHost.replaceChildren(
        createOfflineNotice({
          variant: 'info',
          message: 'Chat history is encrypted & locked • Unlock your .kdbx vault to restore your messages',
          actionLabel: 'Unlock',
          onAction: () => {
            promptUnlockVault({
              onUnlocked: () => refreshSession(),
            });
          },
        })
      );
    } else if (conn.mode === 'offline') {
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

    if (
      state.generating
      && !generating
      && !activeTurnPromise
      && !activeCancelPromise
      && !reattachedMonitor
      && conn.mode === 'online'
      && state.activeSessionId === currentSessionId
      && state.activeProgramId === currentProgramId
    ) {
      startReattachedMonitor();
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
    if (!currentProgramId) {
      const conn = connectionStore.get();
      const resolved = conn.activeProgram || conn.programs?.[0]?.id || '';
      if (resolved) {
        currentProgramId = resolved;
      } else if (conn.mode === 'dormant') {
        return;
      }
    }
    await loadProgramSession(currentProgramId, currentSessionId);
  }

  function reconcileActiveProgramWithConnection() {
    if (destroyed) return false;
    const conn = connectionStore.get();
    const roster = Array.isArray(conn.programs) ? conn.programs : [];
    const fallbackId = conn.activeProgram || roster[0]?.id || '';
    if (!fallbackId) {
      if (conn.mode === 'online' && roster.length === 0 && currentProgramId) {
        currentProgramId = '';
        currentSessionId = 'default';
        hasExplicitProgram = false;
        sessionStore.set({
          activeProgramId: '',
          activeSessionId: 'default',
          characterName: '',
          messages: [],
          welcomeMessage: '',
          loading: false,
        });
      }
      return false;
    }
    const existsInRoster = roster.length === 0 || roster.some((p) => p.id === currentProgramId);
    if (!currentProgramId || (!existsInRoster && (conn.mode === 'online' || !hasExplicitProgram))) {
      if (fallbackId !== currentProgramId) {
        currentProgramId = fallbackId;
        currentSessionId = 'default';
        hasExplicitProgram = false;
        pinnedToBottom = true;
        needsInitialScroll = true;
        lastSessionScrollKey = `${currentProgramId}:${currentSessionId}`;
        if (!generating) {
          void refreshSession();
        }
        return true;
      }
    }
    return false;
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
    stopReattachedMonitor();
    if (nextProgramId) {
      hasExplicitProgram = true;
      currentProgramId = nextProgramId;
    }
    if (nextSessionId) currentSessionId = nextSessionId;
    pinnedToBottom = true;
    needsInitialScroll = true;
    lastSessionScrollKey = `${currentProgramId}:${currentSessionId}`;
    if (draft) textarea.value = String(draft);
    syncComposerHeight();
    clearStagedAttachment();
    attachedSharedPost = null;
    renderAttachmentPreview();
    syncPlaceholder();
    stopActiveSpeech();
    void onProgramChanged?.(currentProgramId, currentSessionId);
    void refreshSession();
  }

  async function submitTurn() {
    if (generating) return;
    const text = textarea.value.trim();
    const stagedFile = attachedFile;
    const stagedPreviewUrl = attachedPreviewUrl;
    let mediaPath = attachedMediaPath;
    const mime = attachedMime;
    const sharedPost = attachedSharedPost;
    const conn = connectionStore.get();

    if (!text && !stagedFile && !mediaPath && !sharedPost) {
      if (conn.mode !== 'online' || !chatContainer.querySelector(LIVE_ROW_SELECTOR)) return;
      const turnGen = turnCounter + 1;
      await withTurnMonitor(currentProgramId, async (signal, typingRow, turnDispatched) => {
        try {
          const contData = await continueGeneration(
            { session_id: currentSessionId, model: selectedModel || undefined },
            { signal }
          );
          if (!signal.aborted) {
            typingRow.remove();
            handleCompletedTurnTools(contData, turnDispatched);
          }
        } catch {
          // Handled cleanly after cancellation settles
        }
      });
      if (!destroyed && turnCounter === turnGen) {
        await refreshSession().catch(() => {});
      }
      return;
    }

    const userMsgId = createUserMessageId();
    const outboundMessage = sharedPost ? formatSharedPostForLlm(sharedPost, text) : text;
    textarea.value = '';
    syncComposerHeight();
    clearStagedAttachment({ revoke: false });
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

    const optimisticUrl = mediaPath || stagedPreviewUrl;
    const optimisticUserMsg = {
      id: userMsgId,
      role: 'user',
      text: outboundMessage,
      media: optimisticUrl ? [{ url: optimisticUrl, type: mime?.startsWith('video/') ? 'video' : 'image' }] : [],
      timestamp: Date.now() / 1000,
      ...(sharedPost ? { shared_post: sharedPost, user_note: text } : {}),
    };

    sessionStore.set((prev) => ({
      messages: [
        ...(Array.isArray(prev.messages) ? prev.messages : []).filter((m) => m?.id !== userMsgId),
        optimisticUserMsg,
      ],
    }));

    const turnGen = turnCounter + 1;
    await withTurnMonitor(currentProgramId, async (signal, typingRow, turnDispatched) => {
      try {
        if (stagedFile && !mediaPath) {
          const upRes = await uploadSanctuaryMedia(stagedFile, { signal });
          mediaPath = upRes.file_path;
          sessionStore.set((prev) => ({
            messages: (Array.isArray(prev.messages) ? prev.messages : []).map((m) =>
              m?.id === userMsgId
                ? { ...m, media: [{ url: mediaPath, type: mime?.startsWith('video/') ? 'video' : 'image' }] }
                : m
            ),
          }));
        }
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
          { signal }
        );
        if (!signal.aborted) {
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
          handleCompletedTurnTools(data, turnDispatched);
        }
      } catch {
        // Handled cleanly after cancellation settles
      } finally {
        if (stagedPreviewUrl && typeof globalThis.URL?.revokeObjectURL === 'function' && stagedPreviewUrl.startsWith('blob:')) {
          try {
            globalThis.URL.revokeObjectURL(stagedPreviewUrl);
          } catch {
            // Ignore revoke errors
          }
        }
      }
    });
    if (!destroyed && turnCounter === turnGen) {
      await refreshSession().catch(() => {});
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
      if (e.isComposing || e.keyCode === 229) {
        return;
      }
      void submitTurn();
    }
  });

  stopBtn.addEventListener('click', () => {
    void stopActiveGeneration();
  });

  const dataTransferFiles = (event) => {
    const items = event?.clipboardData?.items || event?.dataTransfer?.items || [];
    return [...items]
      .filter((item) => item?.kind === 'file' && typeof item.getAsFile === 'function')
      .map((item) => item.getAsFile())
      .filter((file) => file && (file.type?.startsWith('image/') || file.type?.startsWith('video/')));
  };

  const stageIncomingFile = (file) => {
    if (!file || connectionStore.get().mode !== 'online') return;
    clearStagedAttachment();
    attachedFile = file;
    attachedMime = file.type || 'image/png';
    attachedFilename = file.name || 'Pasted image';
    if (
      typeof globalThis.URL?.createObjectURL === 'function'
      && typeof globalThis.Blob !== 'undefined'
      && file instanceof globalThis.Blob
    ) {
      attachedPreviewUrl = globalThis.URL.createObjectURL(file);
    } else {
      attachedPreviewUrl = 'blob:staged-preview';
    }
    renderAttachmentPreview();
  };

  textarea.addEventListener('paste', (e) => {
    // No upload path offline, so clipboard stays native exactly like the attach button
    if (connectionStore.get().mode !== 'online') return;
    const pastedFiles = dataTransferFiles(e);
    if (pastedFiles.length === 0) return;
    // Text-bearing pastes (e.g. web image + caption) keep native text insertion
    if (!e.clipboardData?.getData?.('text/plain')) {
      e.preventDefault();
    }
    stageIncomingFile(pastedFiles[0]);
  });

  textarea.addEventListener('drop', (e) => {
    const droppedFiles = dataTransferFiles(e);
    if (droppedFiles.length === 0) return;
    e.preventDefault();
    stageIncomingFile(droppedFiles[0]);
  });

  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    stageIncomingFile(file);
    fileInput.value = '';
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
    sessionStore.set({ generating: true });
    const ctx = buildRowContext();
    try {
      await streamPortraitGeneration(chatContainer, {
        sessionId: currentSessionId,
        prompt: textarea.value.trim(),
        speakerId: currentProgramId,
        msgId: createProgramMessageId(),
        ctx,
        createTypingRow: () => createTypingIndicatorRow(currentProgramId, ctx),
      });
      await refreshSession();
      scrollToBottom(true);
    } finally {
      sessionStore.set({ generating: false });
      setBusy(false);
    }
  });

  const unsubSession = sessionStore.subscribe(renderSnapshot);
  const unsubConn = connectionStore.subscribe(() => {
    reconcileActiveProgramWithConnection();
    renderSnapshot();
  });
  const unsubOutbox = outboxStore.subscribe(renderSnapshot);
  const offOnline = onSanctuaryEvent('sanctuary:online', () => {
    void refreshModelsAndConfig();
    const switched = reconcileActiveProgramWithConnection();
    if (!generating && !switched) {
      void refreshSession();
    }
  });
  const offVaultChanged = onSanctuaryEvent('sanctuary:vault-changed', (e) => {
    if (destroyed) return;
    if (e?.detail?.unlocked === false) {
      sessionStore.set({ messages: [], moodState: null, vaultLocked: true });
    }
    if (!generating) {
      void refreshSession();
    }
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
      clearStagedAttachment();
      stopReattachedMonitor();
      abortController?.abort();
      stopActiveSpeech();
      chatResizeObserver?.disconnect?.();
      chatContainer.removeEventListener('scroll', onChatScroll);
      chatContainer.removeEventListener('load', onChatMediaLoad, true);
      unsubSession();
      unsubConn();
      unsubOutbox();
      offOnline();
      offVaultChanged();
    },
  };
}
