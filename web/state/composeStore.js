import {
  BLUESKY_MAX_GRAPHEMES,
  MASTODON_MAX_CHARS,
  THREADS_MAX_CHARS,
} from '../constants/endpoints.js';
import {
  deleteSanctuarySocialDraft,
  fetchSanctuarySocialDrafts,
  saveSanctuarySocialDraft,
} from '../queries/sanctuary.js';
import { connectionStore } from './sanctuary/connection.js';
import { kvGet, kvSet, storeDelete, storeGetAll, storePut } from '../storage/nativeStore.js';
import { createStore } from './store.js';

const MAX_DRAFT_MEDIA_BYTES = 8 * 1024 * 1024;
const SERVER_DRAFT_DELETIONS_KEY = 'social_draft_deletions_v1';
let serverDraftSyncPromise = null;

function createInitialComposeState() {
  return {
    isOpen: false,
    activeDraftId: null,
    text: '',
    spoilerText: '',
    contentWarningOpen: false,
    sensitive: false,
    altTextOpen: false,
    visibility: 'public',
    language: 'en',
    mediaAttachments: [],
    threadItems: [],
    linkCard: null,
    dismissedLinkUrl: '',
    replyTo: null,
    targets: {
      fediverse: true,
      bluesky: false,
      threads: false,
    },
    submitting: false,
    error: null,
    sourceMessageId: null,
  };
}

export const composeStore = createStore(createInitialComposeState());

function normalizeMediaItem(item, index = 0) {
  if (typeof item === 'string') {
    return {
      id: `att_${Date.now()}_${index}`,
      url: item,
      previewUrl: item,
      file: null,
      blob: null,
      mimeType: '',
      altText: '',
      source: 'sanctuary',
    };
  }
  return {
    id: item.id || `att_${Date.now()}_${index}`,
    url: item.url || item.previewUrl || '',
    previewUrl: item.previewUrl || item.url || '',
    file: item.file || null,
    blob: item.blob || null,
    mimeType: item.mimeType || item.file?.type || '',
    altText: item.altText || '',
    source: item.source || 'sanctuary',
  };
}

function getReplyMentionPrefix(post) {
  const notifActor = post?._meta?.notification?.actor;
  const rawHandle = notifActor?.handle || post?.author?.handle || post?.author?.acct || '';
  return rawHandle ? `@${String(rawHandle).replace(/^@/, '')} ` : '';
}

export function openCompose(patch = {}) {
  const cur = composeStore.get();
  const nextPatch = { ...patch };
  if (!Object.hasOwn(nextPatch, 'replyTo')) {
    nextPatch.replyTo = null;
    if (cur.replyTo && !Object.hasOwn(nextPatch, 'text')) {
      nextPatch.text = '';
      nextPatch.spoilerText = '';
      nextPatch.contentWarningOpen = false;
      nextPatch.sensitive = false;
      nextPatch.altTextOpen = false;
    }
  }
  composeStore.set({
    ...nextPatch,
    isOpen: true,
    error: null,
  });
}

export function closeCompose() {
  const cur = composeStore.get();
  if (cur.replyTo) {
    const prefix = getReplyMentionPrefix(cur.replyTo);
    const shouldClearText = !cur.text || cur.text === prefix || cur.text.trim() === prefix.trim();
    composeStore.set({
      isOpen: false,
      replyTo: null,
      ...(shouldClearText ? { text: '', spoilerText: '', contentWarningOpen: false } : {}),
    });
    return;
  }
  composeStore.set({ isOpen: false });
}

export function clearComposeReply() {
  const cur = composeStore.get();
  if (!cur.replyTo) return;
  const prefix = getReplyMentionPrefix(cur.replyTo);
  const shouldClearText = !cur.text || cur.text === prefix || cur.text.trim() === prefix.trim();
  composeStore.set({
    replyTo: null,
    ...(shouldClearText ? { text: '', spoilerText: '', contentWarningOpen: false } : {}),
  });
}

export function resetCompose() {
  composeStore.set(createInitialComposeState());
}

/**
 * Populate the composer directly from a user-authored Sanctuary chat bubble.
 * Opens composeModal with raw draft text and any attached turn media.
 * @param {{ messageId?: string | null, text?: string, media?: Array<any>, targets?: Partial<{ fediverse: boolean, bluesky: boolean, threads: boolean }> }} [payload]
 */
export function prefillFromUserBubble({
  messageId = null,
  text = '',
  media = [],
  targets,
} = {}) {
  const prevTargets = composeStore.get().targets;
  const nextMedia = Array.isArray(media)
    ? media.map((m, idx) => normalizeMediaItem(m, idx)).filter((m) => m.url || m.file || m.blob)
    : [];

  composeStore.set({
    isOpen: true,
    activeDraftId: null,
    text: String(text || ''),
    spoilerText: '',
    contentWarningOpen: false,
    sensitive: false,
    altTextOpen: false,
    visibility: 'public',
    mediaAttachments: nextMedia,
    threadItems: [],
    linkCard: null,
    dismissedLinkUrl: '',
    replyTo: null,
    targets: {
      ...prevTargets,
      fediverse: true,
      ...(targets || {}),
    },
    submitting: false,
    error: null,
    sourceMessageId: messageId,
  });
}

export function prefillReply(post) {
  const notifActor = post?._meta?.notification?.actor;
  const rawHandle = notifActor?.handle || post?.author?.handle || post?.author?.acct || '';
  const mentionPrefix = rawHandle ? `@${String(rawHandle).replace(/^@/, '')} ` : '';
  const proto = post?.protocol || (post?.network === 'bluesky' ? 'bluesky' : post?.network === 'threads' ? 'threads' : 'mastodon');
  composeStore.set({
    isOpen: true,
    activeDraftId: null,
    text: mentionPrefix,
    spoilerText: post?._meta?.mastodon?.spoilerText || post?.spoilerText || '',
    contentWarningOpen: Boolean(post?._meta?.mastodon?.spoilerText || post?.spoilerText),
    sensitive: false,
    altTextOpen: false,
    visibility: post?._meta?.mastodon?.visibility || post?.visibility || 'public',
    mediaAttachments: [],
    threadItems: [],
    linkCard: null,
    dismissedLinkUrl: '',
    replyTo: post || null,
    targets: {
      fediverse: proto === 'mastodon',
      bluesky: proto === 'bluesky',
      threads: proto === 'threads',
    },
    submitting: false,
    error: null,
    sourceMessageId: null,
  });
}

export function setComposeText(text) {
  composeStore.set({ text: String(text ?? ''), error: null });
}

export function setComposeLinkCard(card) {
  composeStore.set({ linkCard: card ? { ...card } : null });
}

export function dismissComposeLinkCard(url) {
  composeStore.set({
    linkCard: null,
    dismissedLinkUrl: String(url || ''),
  });
}

export function setSpoilerText(spoilerText) {
  composeStore.set({ spoilerText: String(spoilerText ?? '') });
}

export function setContentWarningOpen(open) {
  composeStore.set((prev) => ({
    contentWarningOpen: Boolean(open),
    spoilerText: open ? prev.spoilerText : '',
  }));
}

export function setComposeSensitive(sensitive) {
  composeStore.set({ sensitive: Boolean(sensitive) });
}

export function setComposeAltTextOpen(open) {
  composeStore.set({ altTextOpen: Boolean(open) });
}

export function setVisibility(visibility) {
  composeStore.set({ visibility });
}

export function toggleTarget(network) {
  composeStore.set((prev) => ({
    targets: {
      ...prev.targets,
      [network]: !prev.targets[network],
    },
  }));
}

export function addMediaAttachment(item) {
  composeStore.set((prev) => ({
    mediaAttachments: [...prev.mediaAttachments, normalizeMediaItem(item, prev.mediaAttachments.length)],
  }));
}

export function updateMediaAltText(attachmentId, altText) {
  composeStore.set((prev) => ({
    mediaAttachments: prev.mediaAttachments.map((att) =>
      att.id === attachmentId ? { ...att, altText: String(altText ?? '') } : att
    ),
  }));
}

export function removeMediaAttachment(attachmentId) {
  composeStore.set((prev) => {
    const nextMedia = prev.mediaAttachments.filter((att) => att.id !== attachmentId);
    return {
      mediaAttachments: nextMedia,
      ...(nextMedia.length === 0 ? { sensitive: false, altTextOpen: false } : {}),
    };
  });
}

export function addThreadItem(initialText = '') {
  composeStore.set((prev) => ({
    threadItems: [
      ...prev.threadItems,
      { id: `thr_${Date.now()}_${prev.threadItems.length}`, text: String(initialText), spoilerText: '' },
    ],
  }));
}

export function updateThreadItem(itemId, patch) {
  composeStore.set((prev) => ({
    threadItems: prev.threadItems.map((it) => (it.id === itemId ? { ...it, ...patch } : it)),
  }));
}

export function removeThreadItem(itemId) {
  composeStore.set((prev) => ({
    threadItems: prev.threadItems.filter((it) => it.id !== itemId),
  }));
}

async function blobToDataUrl(blob) {
  if (!blob || typeof blob.arrayBuffer !== 'function') return null;
  if (Number(blob.size) > MAX_DRAFT_MEDIA_BYTES) return null;
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  const mime = String(blob.type || 'image/png');
  return `data:${mime};base64,${btoa(binary)}`;
}

function dataUrlToBlob(dataUrl, fallbackMime = 'image/png') {
  const str = String(dataUrl || '');
  const commaIdx = str.indexOf(',');
  if (commaIdx < 0) return null;
  const header = str.slice(0, commaIdx);
  const b64 = str.slice(commaIdx + 1);
  const mimeMatch = /^data:([^;]+)/i.exec(header);
  const mime = mimeMatch?.[1] || fallbackMime;
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Blob([bytes], { type: mime });
}

/**
 * List all saved post drafts from native SQLite storage (`drafts`), newest first.
 */
export async function listLocalComposeDrafts() {
  const rows = await storeGetAll('drafts');
  return (Array.isArray(rows) ? rows : [])
    .map((entry) => entry?.value)
    .filter((d) => d && typeof d === 'object' && d.id)
    .sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
}

export async function syncComposeDraftsWithServer() {
  if (serverDraftSyncPromise) return serverDraftSyncPromise;
  const nodeUrl = connectionStore.get().nodeUrl;
  if (!nodeUrl) return false;

  serverDraftSyncPromise = (async () => {
    const pending = await kvGet(SERVER_DRAFT_DELETIONS_KEY, []);
    for (const draftId of Array.isArray(pending) ? pending : []) {
      await deleteSanctuarySocialDraft(String(draftId), { nodeUrl });
    }
    await kvSet(SERVER_DRAFT_DELETIONS_KEY, []);

    const response = await fetchSanctuarySocialDrafts({ nodeUrl });
    const remoteDrafts = Array.isArray(response?.drafts) ? response.drafts : [];
    const deletedIds = new Set(
      Array.isArray(response?.deletedIds) ? response.deletedIds.map(String) : []
    );
    const localDrafts = await listLocalComposeDrafts();
    for (const draftId of deletedIds) {
      await storeDelete('drafts', draftId);
    }

    const remoteById = new Map(
      remoteDrafts.filter((draft) => draft?.id).map((draft) => [draft.id, draft])
    );
    const localIds = new Set(localDrafts.map((draft) => draft.id));

    for (const localDraft of localDrafts) {
      if (deletedIds.has(String(localDraft.id))) continue;
      const remoteDraft = remoteById.get(localDraft.id);
      if (!remoteDraft || Number(localDraft.updatedAt || 0) > Number(remoteDraft.updatedAt || 0)) {
        const saved = await saveSanctuarySocialDraft(localDraft.id, localDraft, { nodeUrl });
        if (saved?.draft) {
          await storePut('drafts', saved.draft.id, saved.draft);
        }
      } else {
        await storePut('drafts', remoteDraft.id, remoteDraft);
      }
    }

    for (const remoteDraft of remoteDrafts) {
      if (remoteDraft?.id && !localIds.has(remoteDraft.id)) {
        await storePut('drafts', remoteDraft.id, remoteDraft);
      }
    }
    return true;
  })().finally(() => {
    serverDraftSyncPromise = null;
  });
  return serverDraftSyncPromise;
}

/**
 * List saved drafts after merging with any drafts on the configured Sanctuary server.
 */
export async function listComposeDrafts() {
  await syncComposeDraftsWithServer();
  return listLocalComposeDrafts();
}

let lastDraftTimestamp = 0;

/**
 * Save the active compose state (text, thread follow-ups, and media blobs <= 8 MB) as a new draft snapshot.
 */
export async function saveCurrentComposeDraft() {
  const s = composeStore.get();
  const hasThreadText = Array.isArray(s.threadItems) && s.threadItems.some((it) => String(it?.text || '').trim());
  const hasContent = Boolean(String(s.text || '').trim() || (s.mediaAttachments?.length > 0) || hasThreadText);
  if (!hasContent) {
    throw new Error('Write something or attach media first.');
  }

  const serializedMedia = [];
  for (const att of s.mediaAttachments || []) {
    const rawBlob = att.file || att.blob || null;
    if (rawBlob) {
      const dataUrl = await blobToDataUrl(rawBlob);
      if (dataUrl) {
        serializedMedia.push({
          id: att.id,
          dataUrl,
          mimeType: att.mimeType || rawBlob.type || 'image/png',
          altText: String(att.altText || ''),
          source: 'draft',
        });
      }
    } else if (att.url && !String(att.url).startsWith('blob:')) {
      serializedMedia.push({
        id: att.id,
        url: att.url,
        mimeType: att.mimeType || '',
        altText: String(att.altText || ''),
        source: att.source || 'sanctuary',
      });
    }
  }

  const now = Math.max(Date.now(), lastDraftTimestamp + 1);
  lastDraftTimestamp = now;

  const draft = {
    id: `draft_${now}_${Math.random().toString(36).slice(2, 8)}`,
    text: String(s.text || ''),
    threadItems: (s.threadItems || []).map((it) => ({
      id: it.id,
      text: String(it.text || ''),
      spoilerText: String(it.spoilerText || ''),
    })),
    spoilerText: String(s.spoilerText || ''),
    sensitive: Boolean(s.sensitive),
    visibility: s.visibility || 'public',
    language: s.language || 'en',
    linkCard: s.linkCard ? { ...s.linkCard } : null,
    dismissedLinkUrl: String(s.dismissedLinkUrl || ''),
    media: serializedMedia,
    updatedAt: now,
  };
  await storePut('drafts', draft.id, draft);
  composeStore.set({ activeDraftId: draft.id });
  try {
    await syncComposeDraftsWithServer();
  } catch (err) {
    throw new Error(`Draft saved locally, but server sync failed: ${err?.message || 'Unknown error'}`);
  }
  return draft;
}

/**
 * Hydrate a saved draft back into the active composer state (converting data URLs back into Blobs).
 */
export function loadComposeDraft(draft) {
  if (!draft || typeof draft !== 'object') return;
  const hydratedMedia = [];
  for (let i = 0; i < (draft.media || []).length; i += 1) {
    const m = draft.media[i];
    if (!m) continue;
    if (m.dataUrl) {
      const blob = dataUrlToBlob(m.dataUrl, m.mimeType || 'image/png');
      hydratedMedia.push({
        id: m.id || `att_${Date.now()}_${i}`,
        blob,
        file: null,
        url: m.dataUrl,
        previewUrl: m.dataUrl,
        mimeType: m.mimeType || blob?.type || 'image/png',
        altText: String(m.altText || ''),
        source: 'draft',
      });
    } else if (m.url) {
      hydratedMedia.push({
        id: m.id || `att_${Date.now()}_${i}`,
        blob: null,
        file: null,
        url: m.url,
        previewUrl: m.url,
        mimeType: m.mimeType || '',
        altText: String(m.altText || ''),
        source: m.source || 'sanctuary',
      });
    }
  }

  composeStore.set({
    isOpen: true,
    activeDraftId: draft.id || null,
    text: String(draft.text || ''),
    threadItems: Array.isArray(draft.threadItems)
      ? draft.threadItems.map((it, idx) => ({
          id: it.id || `thr_${Date.now()}_${idx}`,
          text: String(it.text || ''),
          spoilerText: String(it.spoilerText || ''),
        }))
      : [],
    spoilerText: String(draft.spoilerText || ''),
    contentWarningOpen: Boolean(draft.spoilerText),
    sensitive: Boolean(draft.sensitive),
    altTextOpen: hydratedMedia.some((m) => Boolean(m.altText)),
    visibility: draft.visibility || 'public',
    language: draft.language || 'en',
    linkCard: draft.linkCard ? { ...draft.linkCard } : null,
    dismissedLinkUrl: String(draft.dismissedLinkUrl || ''),
    mediaAttachments: hydratedMedia,
    replyTo: null,
    submitting: false,
    error: null,
  });
}

export async function deleteComposeDraft(draftId) {
  if (!draftId) return;
  await storeDelete('drafts', String(draftId));
  if (composeStore.get().activeDraftId === draftId) {
    composeStore.set({ activeDraftId: null });
  }
  if (connectionStore.get().nodeUrl) {
    const pending = await kvGet(SERVER_DRAFT_DELETIONS_KEY, []);
    const next = Array.isArray(pending) ? pending.map(String) : [];
    if (!next.includes(String(draftId))) next.push(String(draftId));
    await kvSet(SERVER_DRAFT_DELETIONS_KEY, next);
    await syncComposeDraftsWithServer();
  }
}

const graphemeSegmenter = typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
  ? new Intl.Segmenter('en', { granularity: 'grapheme' })
  : null;

/**
 * Count Unicode graphemes accurately for Bluesky ATProto's 300-grapheme limit.
 * @param {string} str
 * @returns {number}
 */
export function countGraphemes(str) {
  const input = String(str || '');
  if (!input) return 0;
  if (graphemeSegmenter) {
    let count = 0;
    for (const _seg of graphemeSegmenter.segment(input)) {
      count += 1;
    }
    return count;
  }
  return [...input].length;
}

/**
 * Compute remaining character / grapheme budgets per target network plus the active tightest limit.
 * @param {ReturnType<typeof composeStore.get>} [state]
 * @param {{ isBlueskyConnected?: boolean, isThreadsConnected?: boolean }} [authState]
 * @returns {{ fediverse: number, bluesky: number, threads: number, tightestLimit: number, tightestRemaining: number }}
 */
export function computeRemainingCounts(state = composeStore.get(), authState = null) {
  const text = state.text || '';
  const cw = state.spoilerText || '';
  const textCodepoints = [...text].length;
  const cwCodepoints = [...cw].length;
  const graphemes = countGraphemes(text);

  const fediverse = MASTODON_MAX_CHARS - (textCodepoints + cwCodepoints);
  const bluesky = BLUESKY_MAX_GRAPHEMES - graphemes;
  const threads = THREADS_MAX_CHARS - textCodepoints;
  const bskyActive = Boolean(authState?.isBlueskyConnected);
  const tightestLimit = bskyActive ? BLUESKY_MAX_GRAPHEMES : MASTODON_MAX_CHARS;
  const tightestRemaining = bskyActive ? bluesky : Math.min(fediverse, authState?.isThreadsConnected ? threads : MASTODON_MAX_CHARS);

  return {
    fediverse,
    bluesky,
    threads,
    tightestLimit,
    tightestRemaining,
  };
}
