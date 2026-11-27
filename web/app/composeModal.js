import { createEmojiPicker } from '../components/EmojiPickerPopover.js';
import { createEmbedCard } from '../components/EmbedCard.js';
import { createComposerMediaEditor } from '../components/MediaAttachment.js';
import { createReplyContextBlock } from '../components/PostCard.js';
import { createClassicModalDialog, showAlert } from '../components/sanctuary/SanctuaryDialog.js';
import { DEFAULT_AVATAR_DATA_URI } from '../constants/avatars.js';
import { BLUESKY_MAX_GRAPHEMES, MASTODON_MAX_CHARS } from '../constants/endpoints.js';
import { shrinkImageBlobForCrosspost } from './crosspostImageResize.js';
import { buildSynthesizedReplyContext, toUnifiedItem } from '../core/schema/unifiedItem.js';
import { createBskyPost, searchBskyActors, uploadBskyBlob } from '../queries/bluesky.js';
import { searchFediverse } from '../queries/fediverse.js';
import { extractFirstHttpsUrl, fetchLinkPreview } from '../queries/linkPreview.js';
import { resolveSanctuaryMediaUrl } from '../queries/sanctuary.js';
import { publishUnified, replyUnified, syncRecentUserPostsToSanctuary } from '../queries/socialClient.js';
import { publishThreadsPost } from '../queries/threads.js';
import { authStore, getAuthenticatedAccount, updateAccountTokens } from '../state/authStore.js';
import { feedStore, mutatePostAcrossStreams, persistStreamCache, recordViewerInteraction } from '../state/feedStore.js';
import {
  addMediaAttachment,
  addThreadItem,
  clearComposeReply,
  closeCompose,
  composeStore,
  computeRemainingCounts,
  deleteComposeDraft,
  dismissComposeLinkCard,
  listComposeDrafts,
  listLocalComposeDrafts,
  loadComposeDraft,
  removeMediaAttachment,
  removeThreadItem,
  resetCompose,
  saveCurrentComposeDraft,
  setComposeLinkCard,
  setComposeText,
  updateThreadItem,
} from '../state/composeStore.js';

const MEDIA_ICON_SVG = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="3" ry="3"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><path d="m21 15-5-5L5 21"></path></svg>`;
const BRIDGE_AUTOSPLIT_NOTE = 'Auto-splits on bridges';

function isMentionCaretChar(code) {
  const isAlnum =
    (code >= 65 && code <= 90)
    || (code >= 97 && code <= 122)
    || (code >= 48 && code <= 57);
  return isAlnum || code === 46 || code === 45 || code === 95 || code === 64; // . - _ @
}

export function extractMentionTokenAtCaret(text, caretPos) {
  const src = String(text || '');
  const pos = Number.isInteger(caretPos) ? Math.max(0, Math.min(caretPos, src.length)) : src.length;
  let start = pos;
  while (start > 0 && isMentionCaretChar(src.charCodeAt(start - 1))) {
    start -= 1;
  }
  const token = src.slice(start, pos);
  if (!token.startsWith('@') || token.length < 3) return null;
  const prevCh = start > 0 ? src[start - 1] : '';
  if (prevCh && prevCh !== ' ' && prevCh !== '\n' && prevCh !== '\r' && prevCh !== '\t' && prevCh !== '(') {
    return null;
  }
  return { query: token.slice(1), start, end: pos };
}

function supportsNativeFieldSizing() {
  return typeof globalThis.CSS?.supports === 'function' && globalThis.CSS.supports('field-sizing', 'content');
}

export function syncAutoHeight(textarea, minHeight = 68, maxHeight = 340) {
  if (!textarea || supportsNativeFieldSizing()) return;
  if (!(textarea.scrollHeight > 0)) {
    textarea.style.removeProperty('height');
    textarea.style.overflowY = 'auto';
    return;
  }
  textarea.style.overflowY = 'hidden';
  textarea.style.height = 'auto';
  const rawScroll = textarea.scrollHeight;
  textarea.style.height = `${Math.max(minHeight, Math.min(rawScroll, maxHeight))}px`;
  textarea.style.overflowY = rawScroll > maxHeight ? 'auto' : 'hidden';
}

function splitOverflowAtLimit(rawText, limit) {
  const full = String(rawText || '');
  const chars = [...full];
  if (chars.length <= limit) {
    return { head: full, tail: '' };
  }
  const rawHead = chars.slice(0, limit).join('');
  const minBreak = Math.floor(limit * 0.5);
  const windowStart = Math.max(minBreak, rawHead.length - 80);
  let breakIdx = -1;
  for (let i = rawHead.length - 1; i >= windowStart; i -= 1) {
    if (rawHead[i] === ' ' || rawHead[i] === '\n') {
      breakIdx = i;
      break;
    }
  }
  if (breakIdx > minBreak) {
    return {
      head: full.slice(0, breakIdx).trimEnd(),
      tail: full.slice(breakIdx + 1).trimStart(),
    };
  }
  return {
    head: rawHead.trimEnd(),
    tail: chars.slice(limit).join('').trimStart(),
  };
}

export function summarizeAccountIdentity(accounts = []) {
  const primary = accounts[0] || null;
  const handle = primary
    ? String(primary.acct || primary.handle || primary.displayName || 'You').replace(/^@/, '')
    : 'You';
  const avatarUrl = primary?.avatar || DEFAULT_AVATAR_DATA_URI;

  const platforms = [];
  if (accounts.some((a) => a.platform === 'fediverse')) platforms.push('Fediverse');
  if (accounts.some((a) => a.platform === 'bluesky')) platforms.push('Bluesky');
  if (accounts.some((a) => a.platform === 'threads')) platforms.push('Threads');

  const destLabel = platforms.length > 0
    ? platforms.join(' · ')
    : 'Connect under User → Accounts';

  return { handle, avatarUrl, destLabel };
}

async function resolveAttachmentBlob(att) {
  if (att.file) return att.file;
  if (att.blob) return att.blob;
  if (att.url) {
    const resolved = att.source === 'sanctuary' ? resolveSanctuaryMediaUrl(att.url) : att.url;
    const res = await fetch(resolved);
    if (!res.ok) throw new Error(`Failed to fetch media attachment (${res.status})`);
    return res.blob();
  }
  return null;
}

async function resolveCrosspostAttachmentBlob(att) {
  const blob = await resolveAttachmentBlob(att);
  if (!blob) return null;
  const shrunk = await shrinkImageBlobForCrosspost(blob);
  if (shrunk === blob) return { blob, mimeType: att.mimeType || blob.type || '' };
  return { blob: shrunk, mimeType: 'image/jpeg' };
}

/**
 * Publish a post (or multi-post thread) organically across connected networks.
 */
export async function publishOrganicPost({
  text = '',
  mediaAttachments = [],
  threadItems = [],
  replyTo = null,
  spoilerText = '',
  visibility = 'public',
  language = 'en',
  linkCard = null,
  dismissLinkCard = false,
} = {}) {
  const cleanText = String(text || '').trim();
  const extraPosts = Array.isArray(threadItems)
    ? threadItems.map((it) => String(it?.text ?? it ?? '').trim()).filter(Boolean)
    : [];
  const attachments = Array.isArray(mediaAttachments) ? mediaAttachments : [];
  if (!cleanText && attachments.length === 0) {
    throw new Error('Write something first.');
  }

  const [fediAccount, bskyAccount, threadsAccount] = await Promise.all([
    getAuthenticatedAccount('fediverse'),
    getAuthenticatedAccount('bluesky'),
    getAuthenticatedAccount('threads'),
  ]);

  const isReply = Boolean(replyTo);
  const replyProto = isReply
    ? (replyTo.protocol || (replyTo.network === 'bluesky' ? 'bluesky' : replyTo.network === 'threads' ? 'threads' : 'mastodon'))
    : '';
  const sendFedi = isReply ? replyProto === 'mastodon' : Boolean(fediAccount);
  const sendBsky = isReply ? replyProto === 'bluesky' : Boolean(bskyAccount);
  const sendThreads = isReply ? replyProto === 'threads' : Boolean(threadsAccount);

  if (isReply) {
    if (sendFedi && !fediAccount) throw new Error('Connect Fediverse under User → Accounts.');
    if (sendBsky && !bskyAccount) throw new Error('Connect Bluesky under User → Accounts.');
    if (sendThreads && !threadsAccount) throw new Error('Connect Threads under User → Accounts.');
  } else if (!sendFedi && !sendBsky && !sendThreads) {
    throw new Error('Connect an account under User → Accounts.');
  }

  const preparedAttachments = [];
  for (const att of attachments) {
    const prepared = await resolveCrosspostAttachmentBlob(att);
    if (!prepared?.blob) continue;
    preparedAttachments.push({
      ...att,
      file: prepared.blob,
      blob: prepared.blob,
      mimeType: prepared.mimeType,
    });
  }

  if (isReply) {
    const targetItem = toUnifiedItem(replyTo);
    const replied = await replyUnified({
      targetItem,
      text: cleanText,
      mediaAttachments: preparedAttachments,
      visibility: visibility || 'public',
    });
    return { results: replied ? [replied] : [], errors: [] };
  }

  if (fediAccount) {
    const out = await publishUnified({
      text: cleanText,
      mediaAttachments: preparedAttachments,
      threadItems: extraPosts,
      visibility: visibility || 'public',
      spoilerText,
      language,
      linkCard,
      dismissLinkCard,
    });
    return {
      results: out.results || out.items || [],
      errors: out.warnings || [],
      linkedIds: out.linkedIds || null,
      retryQueue: out.retryQueue || [],
    };
  }

  const results = [];
  const errors = [];
  let resolvedCard = null;
  if (preparedAttachments.length === 0 && !dismissLinkCard) {
    if (linkCard?.url && String(linkCard.url).startsWith('https://')) {
      resolvedCard = { ...linkCard };
    } else {
      const firstUrl = extractFirstHttpsUrl(cleanText);
      if (firstUrl) {
        resolvedCard = await fetchLinkPreview(firstUrl).catch(() => null);
      }
    }
  }

  if (sendBsky && bskyAccount) {
    try {
      const uploadedImages = [];
      for (const att of preparedAttachments.slice(0, 4)) {
        if (!att.blob) continue;
        const uploadedBlob = await uploadBskyBlob({
          serviceUrl: bskyAccount.meta.serviceUrl,
          accessJwt: bskyAccount.secrets.accessJwt,
          refreshJwt: bskyAccount.secrets.refreshJwt,
          onSessionRefreshed: (tok) => updateAccountTokens(bskyAccount.meta.id, tok),
          blob: att.blob,
          mimeType: att.mimeType || att.blob.type || 'image/jpeg',
        });
        uploadedImages.push({ alt: att.altText || '', blob: uploadedBlob });
      }
      const replyParentRef = replyTo?.network === 'bluesky'
        ? { uri: replyTo.uri, cid: replyTo.cid }
        : null;
      const created = await createBskyPost({
        serviceUrl: bskyAccount.meta.serviceUrl,
        repo: bskyAccount.meta.did,
        accessJwt: bskyAccount.secrets.accessJwt,
        refreshJwt: bskyAccount.secrets.refreshJwt,
        onSessionRefreshed: (tok) => updateAccountTokens(bskyAccount.meta.id, tok),
        text: cleanText,
        images: uploadedImages,
        externalEmbed: uploadedImages.length === 0 ? resolvedCard : null,
        reply: replyParentRef ? { root: replyParentRef, parent: replyParentRef } : null,
      });
      results.push(created);

      if (extraPosts.length > 0 && created?.uri && created?.cid) {
        const rootRef = replyParentRef || { uri: created.uri, cid: created.cid };
        let currentParentRef = { uri: created.uri, cid: created.cid };
        for (const followUpText of extraPosts) {
          const nextCreated = await createBskyPost({
            serviceUrl: bskyAccount.meta.serviceUrl,
            repo: bskyAccount.meta.did,
            accessJwt: bskyAccount.secrets.accessJwt,
            refreshJwt: bskyAccount.secrets.refreshJwt,
            onSessionRefreshed: (tok) => updateAccountTokens(bskyAccount.meta.id, tok),
            text: followUpText,
            reply: { root: rootRef, parent: currentParentRef },
          });
          results.push(nextCreated);
          if (nextCreated?.uri && nextCreated?.cid) {
            currentParentRef = { uri: nextCreated.uri, cid: nextCreated.cid };
          }
        }
      }
    } catch (err) {
      errors.push(`Bluesky: ${err?.message || 'publish failed'}`);
    }
  }

  if (sendThreads && threadsAccount) {
    try {
      const thr = await publishThreadsPost({
        userId: threadsAccount.meta.userId,
        accessToken: threadsAccount.secrets.accessToken,
        text: cleanText,
        media: preparedAttachments,
        mastodonUrls: [],
        publicMediaBaseUrl: authStore.get().publicMediaBaseUrl || '',
        ...(preparedAttachments.length === 0 && resolvedCard?.url ? { linkAttachment: resolvedCard.url } : {}),
      });
      results.push(thr);

      if (extraPosts.length > 0 && thr?.id) {
        let currentParentId = thr.id;
        for (const followUpText of extraPosts) {
          const nextThr = await publishThreadsPost({
            userId: threadsAccount.meta.userId,
            accessToken: threadsAccount.secrets.accessToken,
            text: followUpText,
            replyToId: currentParentId,
          });
          results.push(nextThr);
          if (nextThr?.id) currentParentId = nextThr.id;
        }
      }
    } catch (err) {
      errors.push(`Threads: ${err?.message || 'publish failed'}`);
    }
  }

  if (results.length === 0 && errors.length > 0) {
    throw new Error(errors.join(' | '));
  }
  return { results, errors };
}

/**
 * Mount the unified New Post dialog (<dialog class="classic-modal-dialog">).
 * Single organic Post button publishes across all signed-in networks without per-post toggles.
 */
export function mountComposeModal(hostEl, { onPublished } = {}) {
  const doc = globalThis.document;
  let viewingDrafts = false;
  let draftsList = [];
  let lastPreviewTargetUrl = '';
  let lastRenderedLinkCardSig = '';
  let linkPreviewTimer = null;
  let linkPreviewAbort = null;
  const activeTextTarget = { kind: 'main', itemId: null, start: 0, end: 0 };

  const clearPendingLinkPreview = () => {
    clearTimeout(linkPreviewTimer);
    linkPreviewTimer = null;
    linkPreviewAbort?.abort();
    linkPreviewAbort = null;
  };

  const captureCaret = (kind, itemId, el) => {
    activeTextTarget.kind = kind;
    activeTextTarget.itemId = itemId;
    if (typeof el?.selectionStart === 'number') {
      activeTextTarget.start = el.selectionStart;
      activeTextTarget.end = typeof el.selectionEnd === 'number' ? el.selectionEnd : el.selectionStart;
    } else {
      const len = String(el?.value || '').length;
      activeTextTarget.start = len;
      activeTextTarget.end = len;
    }
  };

  const dismissCompose = () => {
    clearPendingLinkPreview();
    closeMentionMenu?.();
    if (composeStore.get().activeDraftId) {
      resetCompose();
      return;
    }
    if (composeStore.get().isOpen) {
      closeCompose();
    }
  };

  const modal = createClassicModalDialog({
    id: 'compose-post-dialog',
    maxWidth: '560px',
    closedBy: 'any',
    onClose: () => {
      viewingDrafts = false;
      dismissCompose();
    },
  });
  modal.closeBtn.hidden = true;
  modal.card.classList.add('compose-sheet-card');

  const header = doc.createElement('header');
  header.className = 'compose-sheet-header';

  const cancelBtn = doc.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'compose-cancel-btn';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', () => {
    if (viewingDrafts) {
      viewingDrafts = false;
      syncUi(composeStore.get(), authStore.get());
      return;
    }
    dismissCompose();
  });

  const titleEl = doc.createElement('h3');
  titleEl.id = modal.titleId;
  titleEl.className = 'compose-sheet-title';
  titleEl.textContent = 'New post';

  const countsEl = doc.createElement('span');
  countsEl.className = 'compose-counts';
  countsEl.setAttribute('aria-live', 'polite');

  header.append(cancelBtn, titleEl, countsEl);

  const body = doc.createElement('div');
  body.className = 'compose-sheet-body';

  const replyBanner = doc.createElement('div');
  replyBanner.className = 'compose-reply-banner';
  replyBanner.hidden = true;

  const mainUnit = doc.createElement('div');
  mainUnit.className = 'compose-thread-unit';

  const avatarCol = doc.createElement('div');
  avatarCol.className = 'compose-avatar-col';

  const mainAvatarImg = doc.createElement('img');
  mainAvatarImg.className = 'compose-user-avatar';
  mainAvatarImg.alt = '';
  mainAvatarImg.src = DEFAULT_AVATAR_DATA_URI;

  const mainRail = doc.createElement('div');
  mainRail.className = 'compose-thread-rail';
  avatarCol.append(mainAvatarImg, mainRail);

  const editorCol = doc.createElement('div');
  editorCol.className = 'compose-editor-col';

  const authorLine = doc.createElement('div');
  authorLine.className = 'compose-author-line';

  const authorHandleEl = doc.createElement('span');
  authorHandleEl.className = 'compose-author-handle';

  const authorDestEl = doc.createElement('span');
  authorDestEl.className = 'compose-author-dest';
  authorLine.append(authorHandleEl, authorDestEl);

  const mainLbl = doc.createElement('label');
  mainLbl.setAttribute('for', 'compose-main-textarea');
  mainLbl.className = 'sr-only';
  mainLbl.textContent = 'Post text';

  const textarea = doc.createElement('textarea');
  textarea.id = 'compose-main-textarea';
  textarea.className = 'compose-seamless-textarea';
  textarea.rows = 3;
  textarea.placeholder = "What's new?";
  textarea.setAttribute('autofocus', '');
  textarea.addEventListener('input', () => {
    setComposeText(textarea.value);
    syncAutoHeight(textarea);
    captureCaret('main', null, textarea);
    scheduleMentionLookup('main', null, textarea);
  });
  textarea.addEventListener('keydown', (e) => handleMentionKeydown(e));
  for (const evt of ['focus', 'keyup', 'mouseup', 'blur']) {
    textarea.addEventListener(evt, () => captureCaret('main', null, textarea));
  }

  const mentionMenuEl = doc.createElement('div');
  mentionMenuEl.className = 'compose-mention-menu';
  mentionMenuEl.setAttribute('role', 'listbox');
  mentionMenuEl.setAttribute('aria-label', 'Mention suggestions');
  mentionMenuEl.hidden = true;

  let mentionTimer = null;
  let mentionEpoch = 0;
  let mentionSuggestions = [];
  let mentionActiveIdx = 0;
  let mentionMatch = null;
  let mentionTargetInput = null;
  let mentionTargetKind = 'main';
  let mentionTargetItemId = null;

  function closeMentionMenu() {
    clearTimeout(mentionTimer);
    mentionTimer = null;
    mentionEpoch += 1;
    mentionSuggestions = [];
    mentionActiveIdx = 0;
    mentionMatch = null;
    mentionMenuEl.hidden = true;
    mentionMenuEl.replaceChildren();
  }

  function applyMentionSelection(idx) {
    const item = mentionSuggestions[idx];
    const targetInput = mentionTargetInput;
    if (!item || !mentionMatch || !targetInput) return;
    const current = String(targetInput.value || '');
    const before = current.slice(0, mentionMatch.start);
    const after = current.slice(mentionMatch.end);
    const spacer = after.startsWith(' ') ? '' : ' ';
    const inserted = `@${item.insertHandle}${spacer}`;
    const nextText = `${before}${inserted}${after}`;
    const nextPos = before.length + inserted.length;

    if (mentionTargetKind === 'thread' && mentionTargetItemId) {
      updateThreadItem(mentionTargetItemId, { text: nextText });
    } else {
      setComposeText(nextText);
    }
    targetInput.value = nextText;
    syncAutoHeight(targetInput, mentionTargetKind === 'thread' ? 52 : 68, mentionTargetKind === 'thread' ? 260 : 340);
    targetInput.focus?.();
    targetInput.setSelectionRange?.(nextPos, nextPos);
    activeTextTarget.kind = mentionTargetKind;
    activeTextTarget.itemId = mentionTargetItemId;
    activeTextTarget.start = nextPos;
    activeTextTarget.end = nextPos;
    closeMentionMenu();
  }

  function renderMentionMenu() {
    mentionMenuEl.replaceChildren();
    if (mentionSuggestions.length === 0) {
      mentionMenuEl.hidden = true;
      return;
    }
    mentionMenuEl.hidden = false;
    mentionSuggestions.forEach((s, idx) => {
      const opt = doc.createElement('button');
      opt.type = 'button';
      opt.className = `compose-mention-option${idx === mentionActiveIdx ? ' is-selected' : ''}`;
      opt.setAttribute('role', 'option');
      opt.setAttribute('aria-selected', idx === mentionActiveIdx ? 'true' : 'false');

      const av = doc.createElement('img');
      av.className = 'compose-mention-avatar';
      av.src = s.avatar || DEFAULT_AVATAR_DATA_URI;
      av.alt = '';

      const meta = doc.createElement('span');
      meta.className = 'compose-mention-meta';
      const nameEl = doc.createElement('span');
      nameEl.className = 'compose-mention-name';
      nameEl.textContent = s.displayName || s.insertHandle;
      const handleEl = doc.createElement('span');
      handleEl.className = 'compose-mention-handle';
      handleEl.textContent = `@${s.insertHandle}`;
      meta.append(nameEl, handleEl);

      const protoEl = doc.createElement('span');
      protoEl.className = `post-protocol-badge post-protocol-badge--${s.protocol}`;
      protoEl.textContent = s.protocol === 'bluesky' ? 'Bluesky' : 'Fediverse';

      opt.append(av, meta, protoEl);
      opt.addEventListener('mousedown', (e) => {
        e.preventDefault();
        applyMentionSelection(idx);
      });
      mentionMenuEl.appendChild(opt);
    });
  }

  function handleMentionKeydown(e) {
    if (mentionMenuEl.hidden || mentionSuggestions.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      mentionActiveIdx = (mentionActiveIdx + 1) % mentionSuggestions.length;
      renderMentionMenu();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      mentionActiveIdx = (mentionActiveIdx - 1 + mentionSuggestions.length) % mentionSuggestions.length;
      renderMentionMenu();
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      applyMentionSelection(mentionActiveIdx);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closeMentionMenu();
    }
  }

  function scheduleMentionLookup(kind, itemId, targetInput) {
    const caret = typeof targetInput?.selectionStart === 'number'
      ? targetInput.selectionStart
      : String(targetInput?.value || '').length;
    const match = extractMentionTokenAtCaret(targetInput?.value || '', caret);
    if (!match) {
      closeMentionMenu();
      return;
    }
    mentionMatch = match;
    mentionTargetInput = targetInput;
    mentionTargetKind = kind;
    mentionTargetItemId = itemId;
    clearTimeout(mentionTimer);
    const epoch = ++mentionEpoch;
    mentionTimer = setTimeout(() => {
      void (async () => {
        const accts = authStore.get().accounts || [];
        const bskyAcc = accts.find((a) => a.platform === 'bluesky');
        const fediAcc = accts.find((a) => a.platform === 'fediverse');
        const lookups = [];
        if (bskyAcc) {
          lookups.push(
            searchBskyActors({
              query: match.query,
              limit: 4,
              serviceUrl: bskyAcc.serviceUrl || bskyAcc.meta?.serviceUrl,
            })
              .then((res) =>
                (Array.isArray(res?.actors) ? res.actors : [])
                  .filter((a) => a?.handle)
                  .map((a) => ({
                    protocol: 'bluesky',
                    insertHandle: String(a.handle).replace(/^@/, ''),
                    displayName: a.displayName || a.handle,
                    avatar: a.avatar || '',
                  }))
              )
              .catch(() => [])
          );
        }
        if (fediAcc && fediAcc.instanceUrl) {
          lookups.push(
            searchFediverse({
              instanceUrl: fediAcc.instanceUrl,
              query: match.query,
              type: 'accounts',
              resolve: false,
              limit: 4,
            })
              .then((res) =>
                (Array.isArray(res?.accounts) ? res.accounts : [])
                  .filter((a) => a?.acct)
                  .map((a) => ({
                    protocol: 'mastodon',
                    insertHandle: String(a.acct).replace(/^@/, ''),
                    displayName: a.displayName || a.acct,
                    avatar: a.avatar || '',
                  }))
              )
              .catch(() => [])
          );
        }
        if (lookups.length === 0) {
          if (epoch === mentionEpoch) closeMentionMenu();
          return;
        }
        const lists = await Promise.all(lookups);
        if (epoch !== mentionEpoch) return;
        const merged = [];
        const seen = new Set();
        for (const list of lists) {
          for (const entry of list) {
            const key = `${entry.protocol}:${entry.insertHandle.toLowerCase()}`;
            if (seen.has(key)) continue;
            seen.add(key);
            merged.push(entry);
            if (merged.length >= 6) break;
          }
          if (merged.length >= 6) break;
        }
        mentionSuggestions = merged;
        mentionActiveIdx = 0;
        renderMentionMenu();
      })();
    }, 180);
  }

  const mediaHostEl = doc.createElement('div');
  mediaHostEl.className = 'compose-media-host';

  const linkPreviewHostEl = doc.createElement('div');
  linkPreviewHostEl.className = 'compose-link-preview-host';

  const inlineTools = doc.createElement('div');
  inlineTools.className = 'compose-inline-tools';

  const fileInput = doc.createElement('input');
  fileInput.type = 'file';
  fileInput.id = 'compose-file-picker';
  fileInput.accept = 'image/*,video/*,audio/*';
  fileInput.multiple = true;
  fileInput.className = 'sr-only';
  fileInput.hidden = true;

  const attachBtn = doc.createElement('button');
  attachBtn.type = 'button';
  attachBtn.className = 'compose-tool-icon-btn';
  attachBtn.setAttribute('aria-label', 'Attach Media');
  attachBtn.title = 'Attach Media';
  attachBtn.innerHTML = MEDIA_ICON_SVG;
  attachBtn.addEventListener('click', () => fileInput.click());

  fileInput.addEventListener('change', () => {
    for (const file of fileInput.files || []) {
      const previewUrl = typeof URL?.createObjectURL === 'function' ? URL.createObjectURL(file) : '';
      addMediaAttachment({
        file,
        previewUrl,
        url: previewUrl,
        mimeType: file.type,
        source: 'local-file',
      });
    }
    fileInput.value = '';
  });

  function insertEmojiAtCursor(emoji) {
    const isThreadTarget = activeTextTarget.kind === 'thread' && activeTextTarget.itemId;
    const threadEntry = isThreadTarget ? renderedThreadRows.get(activeTextTarget.itemId) : null;
    const targetInput = threadEntry?.extraTextarea || textarea;
    const current = String(targetInput?.value ?? '');
    const rawStart = Number.isInteger(activeTextTarget.start) ? activeTextTarget.start : current.length;
    const rawEnd = Number.isInteger(activeTextTarget.end) ? activeTextTarget.end : rawStart;
    const start = Math.max(0, Math.min(rawStart, current.length));
    const end = Math.max(start, Math.min(rawEnd, current.length));
    const nextText = `${current.slice(0, start)}${emoji}${current.slice(end)}`;
    const nextPos = start + emoji.length;

    activeTextTarget.start = nextPos;
    activeTextTarget.end = nextPos;
    if (threadEntry) {
      updateThreadItem(activeTextTarget.itemId, { text: nextText });
    } else {
      setComposeText(nextText);
    }
    if (targetInput) {
      targetInput.value = nextText;
      syncAutoHeight(targetInput, threadEntry ? 52 : 68, threadEntry ? 260 : 340);
      targetInput.focus?.();
      targetInput.setSelectionRange?.(nextPos, nextPos);
    }
  }

  const emojiPicker = createEmojiPicker({
    popoverId: 'compose-emoji-popover',
    onSelectEmoji: insertEmojiAtCursor,
  });

  inlineTools.append(attachBtn, emojiPicker.triggerBtn, emojiPicker.panel, fileInput);
  editorCol.append(authorLine, mainLbl, textarea, mentionMenuEl, mediaHostEl, linkPreviewHostEl, inlineTools);
  mainUnit.append(avatarCol, editorCol);

  const threadExtraList = doc.createElement('div');
  threadExtraList.className = 'compose-thread-extra-list';

  const addThreadRow = doc.createElement('div');
  addThreadRow.className = 'compose-add-thread-row';

  const miniAvatarImg = doc.createElement('img');
  miniAvatarImg.className = 'compose-mini-avatar';
  miniAvatarImg.alt = '';
  miniAvatarImg.src = DEFAULT_AVATAR_DATA_URI;

  const addThreadBtn = doc.createElement('button');
  addThreadBtn.type = 'button';
  addThreadBtn.className = 'compose-add-thread-btn';
  addThreadBtn.textContent = 'Add to post';

  addThreadRow.append(miniAvatarImg, addThreadBtn);
  body.append(replyBanner, mainUnit, threadExtraList, addThreadRow);

  const draftsBody = doc.createElement('div');
  draftsBody.className = 'compose-drafts-view';
  draftsBody.hidden = true;

  const footer = doc.createElement('footer');
  footer.className = 'compose-sheet-footer';

  const footerLeft = doc.createElement('div');
  footerLeft.className = 'compose-footer-left';

  const saveDraftBtn = doc.createElement('button');
  saveDraftBtn.type = 'button';
  saveDraftBtn.className = 'compose-draft-btn';
  saveDraftBtn.textContent = 'Save draft';

  const viewDraftsBtn = doc.createElement('button');
  viewDraftsBtn.type = 'button';
  viewDraftsBtn.className = 'compose-drafts-toggle-btn';
  viewDraftsBtn.textContent = 'Drafts';

  footerLeft.append(saveDraftBtn, viewDraftsBtn);

  const statusLine = doc.createElement('p');
  statusLine.className = 'compose-status-msg';
  statusLine.setAttribute('role', 'status');
  statusLine.setAttribute('aria-live', 'polite');

  const publishBtn = doc.createElement('button');
  publishBtn.type = 'button';
  publishBtn.className = 'compose-publish-btn';
  publishBtn.textContent = 'Post';

  footer.append(footerLeft, statusLine, publishBtn);
  modal.card.append(header, body, draftsBody, footer);
  hostEl.appendChild(modal.dialog);

  const renderedThreadRows = new Map();
  let lastMediaSignature = '';

  const syncAllTextareaHeights = () => {
    syncAutoHeight(textarea, 68, 340);
    for (const entry of renderedThreadRows.values()) {
      syncAutoHeight(entry.extraTextarea, 52, 260);
    }
  };

  function formatDraftAge(ts) {
    if (!Number.isFinite(ts)) return 'Saved';
    const diffSec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
    if (diffSec < 60) return 'Just now';
    if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
    if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
    return new Date(ts).toLocaleDateString();
  }

  function renderDraftsView() {
    viewDraftsBtn.textContent = draftsList.length > 0 ? `Drafts (${draftsList.length})` : 'Drafts';
    draftsBody.replaceChildren();
    if (!viewingDrafts) return;

    if (draftsList.length === 0) {
      const empty = doc.createElement('p');
      empty.className = 'empty-state compose-drafts-empty';
      empty.textContent = 'No saved drafts yet.';
      draftsBody.appendChild(empty);
      return;
    }

    for (const draft of draftsList) {
      const row = doc.createElement('div');
      row.className = 'compose-draft-item';

      const selectBtn = doc.createElement('button');
      selectBtn.type = 'button';
      selectBtn.className = 'compose-draft-select-btn';

      const firstThumb = draft.media?.[0]?.dataUrl || draft.media?.[0]?.url || '';
      if (firstThumb) {
        const thumb = doc.createElement('img');
        thumb.className = 'compose-draft-thumb';
        thumb.src = firstThumb;
        thumb.alt = '';
        selectBtn.appendChild(thumb);
      }

      const info = doc.createElement('div');
      info.className = 'compose-draft-info';
      const snippet = doc.createElement('span');
      snippet.className = 'compose-draft-snippet';
      snippet.textContent = String(draft.text || '').trim()
        || String(draft.threadItems?.[0]?.text || '').trim()
        || 'Attached media';

      const metaParts = [formatDraftAge(draft.updatedAt)];
      if (draft.media?.length > 0) metaParts.push(`${draft.media.length} media`);
      if (draft.threadItems?.length > 0) metaParts.push(`${draft.threadItems.length + 1} posts`);

      const meta = doc.createElement('span');
      meta.className = 'compose-draft-meta';
      meta.textContent = metaParts.join(' · ');

      info.append(snippet, meta);
      selectBtn.appendChild(info);
      selectBtn.addEventListener('click', () => {
        viewingDrafts = false;
        loadComposeDraft(draft);
        syncUi(composeStore.get(), authStore.get());
        syncAllTextareaHeights();
        textarea.focus?.();
      });

      const delBtn = doc.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'compose-draft-delete-btn';
      delBtn.setAttribute('aria-label', 'Delete draft');
      delBtn.title = 'Delete draft';
      delBtn.textContent = '×';
      delBtn.addEventListener('click', async () => {
        delBtn.disabled = true;
        try {
          await deleteComposeDraft(draft.id);
        } catch (err) {
          statusLine.textContent = `Draft deleted on this device, but server sync failed: ${err?.message || 'Unknown error'}`;
        }
        await refreshDraftsList();
      });

      row.append(selectBtn, delBtn);
      draftsBody.appendChild(row);
    }
  }

  async function refreshDraftsList() {
    draftsList = await listLocalComposeDrafts();
    renderDraftsView();
    try {
      draftsList = await listComposeDrafts();
      statusLine.textContent = '';
    } catch (err) {
      draftsList = await listLocalComposeDrafts();
      statusLine.textContent = `Showing device drafts; server sync failed: ${err?.message || 'Unknown error'}`;
    }
    renderDraftsView();
  }

  saveDraftBtn.addEventListener('click', async () => {
    saveDraftBtn.disabled = true;
    statusLine.textContent = '';
    try {
      await saveCurrentComposeDraft();
      await refreshDraftsList();
      statusLine.textContent = 'Draft saved.';
    } catch (err) {
      statusLine.textContent = err?.message || 'Unable to save draft.';
    } finally {
      saveDraftBtn.disabled = false;
    }
  });

  viewDraftsBtn.addEventListener('click', () => {
    viewingDrafts = !viewingDrafts;
    syncUi(composeStore.get(), authStore.get());
    if (viewingDrafts) void refreshDraftsList();
  });

  function createFollowUpRow(item) {
    const rowEl = doc.createElement('div');
    rowEl.className = 'compose-thread-unit is-followup';

    const colAvatar = doc.createElement('div');
    colAvatar.className = 'compose-avatar-col';

    const avImg = doc.createElement('img');
    avImg.className = 'compose-user-avatar';
    avImg.alt = '';
    avImg.src = mainAvatarImg.src;

    const rail = doc.createElement('div');
    rail.className = 'compose-thread-rail';
    colAvatar.append(avImg, rail);

    const colEditor = doc.createElement('div');
    colEditor.className = 'compose-editor-col';

    const topRow = doc.createElement('div');
    topRow.className = 'compose-author-line';

    const handleEl = doc.createElement('span');
    handleEl.className = 'compose-author-handle';
    handleEl.textContent = authorHandleEl.textContent;

    const itemCountEl = doc.createElement('span');
    itemCountEl.className = 'compose-item-count';

    const removeBtn = doc.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'compose-remove-thread-btn';
    removeBtn.setAttribute('aria-label', 'Remove comment');
    removeBtn.textContent = '×';
    removeBtn.addEventListener('click', () => removeThreadItem(item.id));
    topRow.append(handleEl, itemCountEl, removeBtn);

    const extraTextarea = doc.createElement('textarea');
    extraTextarea.className = 'compose-seamless-textarea';
    extraTextarea.rows = 2;
    extraTextarea.placeholder = 'Add a follow-up comment...';
    extraTextarea.value = item.text || '';
    extraTextarea.addEventListener('input', () => {
      updateThreadItem(item.id, { text: extraTextarea.value });
      syncAutoHeight(extraTextarea, 52, 220);
      captureCaret('thread', item.id, extraTextarea);
      scheduleMentionLookup('thread', item.id, extraTextarea);
    });
    extraTextarea.addEventListener('keydown', (e) => handleMentionKeydown(e));
    for (const evt of ['focus', 'keyup', 'mouseup', 'blur']) {
      extraTextarea.addEventListener(evt, () => captureCaret('thread', item.id, extraTextarea));
    }

    colEditor.append(topRow, extraTextarea);
    rowEl.append(colAvatar, colEditor);
    return { rowEl, avImg, handleEl, itemCountEl, extraTextarea };
  }

  addThreadBtn.addEventListener('click', () => {
    const s = composeStore.get();
    const accts = authStore.get().accounts || [];
    const maxLimit = accts.some((a) => a.platform === 'bluesky') ? BLUESKY_MAX_GRAPHEMES : MASTODON_MAX_CHARS;
    const extraItems = Array.isArray(s.threadItems) ? s.threadItems : [];

    if (extraItems.length === 0 && [...(s.text || '')].length > maxLimit) {
      const { head, tail } = splitOverflowAtLimit(s.text, maxLimit);
      setComposeText(head);
      addThreadItem(tail);
    } else if (extraItems.length > 0 && [...(extraItems[extraItems.length - 1].text || '')].length > maxLimit) {
      const lastItem = extraItems[extraItems.length - 1];
      const { head, tail } = splitOverflowAtLimit(lastItem.text, maxLimit);
      updateThreadItem(lastItem.id, { text: head });
      addThreadItem(tail);
    } else {
      addThreadItem('');
    }

    const items = composeStore.get().threadItems;
    const newest = items[items.length - 1];
    if (newest) {
      const ta = renderedThreadRows.get(newest.id)?.extraTextarea;
      ta?.focus?.();
      if (ta && typeof ta.setSelectionRange === 'function') {
        const end = ta.value.length;
        ta.setSelectionRange(end, end);
      }
    }
  });

  function syncLinkPreviewForState(s) {
    const firstUrl = s.isOpen && !s.replyTo && s.mediaAttachments.length === 0
      ? extractFirstHttpsUrl(s.text)
      : '';
    if (!firstUrl || firstUrl === s.dismissedLinkUrl) {
      lastPreviewTargetUrl = '';
      clearPendingLinkPreview();
      if (s.linkCard) {
        queueMicrotask(() => setComposeLinkCard(null));
      }
      return;
    }
    if (firstUrl === lastPreviewTargetUrl) return;
    lastPreviewTargetUrl = firstUrl;
    clearPendingLinkPreview();
    if (s.linkCard && s.linkCard.url !== firstUrl) {
      queueMicrotask(() => setComposeLinkCard(null));
    }
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    linkPreviewAbort = controller;
    linkPreviewTimer = setTimeout(() => {
      linkPreviewTimer = null;
      void fetchLinkPreview(firstUrl, { signal: controller?.signal })
        .then((card) => {
          if (controller?.signal?.aborted) return;
          const cur = composeStore.get();
          if (!cur.isOpen || cur.mediaAttachments.length > 0) return;
          if (extractFirstHttpsUrl(cur.text) !== firstUrl || cur.dismissedLinkUrl === firstUrl) return;
          setComposeLinkCard(card);
        })
        .catch(() => {});
    }, 180);
  }

  async function publishAll() {
    clearPendingLinkPreview();
    const s = composeStore.get();
    const consumedDraftId = s.activeDraftId;
    composeStore.set({ submitting: true, error: null });
    publishBtn.disabled = true;
    statusLine.textContent = 'Posting...';
    try {
      const { results, errors } = await publishOrganicPost({
        text: s.text,
        mediaAttachments: s.mediaAttachments,
        threadItems: s.threadItems,
        replyTo: s.replyTo,
        spoilerText: s.spoilerText,
        visibility: s.visibility,
        language: s.language,
        linkCard: s.mediaAttachments.length === 0 ? s.linkCard : null,
        dismissLinkCard: Boolean(
          s.dismissedLinkUrl && s.dismissedLinkUrl === extractFirstHttpsUrl(s.text)
        ),
      });
      const warnMsg = errors.length > 0 ? errors.join('\n\n') : '';
      let draftSyncWarning = '';
      if (consumedDraftId) {
        try {
          await deleteComposeDraft(consumedDraftId);
        } catch (err) {
          draftSyncWarning = `The post was published, but draft deletion did not sync: ${err?.message || 'Unknown error'}`;
        }
        await refreshDraftsList();
      }
      if (s.replyTo && Array.isArray(results) && results.length > 0) {
        const parentTarget = toUnifiedItem(s.replyTo);
        const parentId = String(parentTarget.id || '');
        const parentMastoId = String(parentTarget._meta?.mastodon?.statusId || '');
        const parentBskyUri = String(parentTarget._meta?.bluesky?.uri || '');
        const parentUrl = String(parentTarget.url || '');
        const markReplied = (item) => {
          const base = toUnifiedItem(item);
          const nextMeta = { ...(base._meta || {}), viewerReplied: true };
          if (base.protocol === 'mastodon' || nextMeta.mastodon) {
            nextMeta.mastodon = { ...(nextMeta.mastodon || {}), replied: true };
          }
          if (base.protocol === 'bluesky' || nextMeta.bluesky) {
            nextMeta.bluesky = { ...(nextMeta.bluesky || {}), replied: true };
          }
          return {
            ...base,
            metrics: {
              ...(base.metrics || { replies: 0, reposts: 0, likes: 0 }),
              replies: Number(base.metrics?.replies ?? 0) + 1,
            },
            _meta: nextMeta,
          };
        };
        recordViewerInteraction(markReplied(parentTarget));
        mutatePostAcrossStreams(
          (item) =>
            (parentId && item?.id === parentId)
            || (parentMastoId && item?._meta?.mastodon?.statusId === parentMastoId)
            || (parentBskyUri && item?._meta?.bluesky?.uri === parentBskyUri)
            || (parentUrl && item?.url === parentUrl),
          markReplied
        );
        const activeName = feedStore.get().activeStream || 'feed';
        void persistStreamCache(activeName).catch(() => {});
      }
      if (!s.replyTo && Array.isArray(results) && results.length > 0) {
        void syncRecentUserPostsToSanctuary({ freshItems: results }).catch(() => {});
      }
      resetCompose();
      modal.close();
      await onPublished?.(results);
      if (warnMsg || draftSyncWarning) {
        showAlert('Bridge Sync Warning', [warnMsg, draftSyncWarning].filter(Boolean).join('\n\n'));
      }
    } catch (err) {
      composeStore.set({ submitting: false, error: err?.message || 'Publish failed' });
      statusLine.textContent = err?.message || 'Publish failed';
    } finally {
      publishBtn.disabled = false;
    }
  }

  publishBtn.addEventListener('click', () => void publishAll());

  function minRemainingForItem(itemState, hasFedi, hasBsky, hasThreads) {
    const rem = computeRemainingCounts(itemState);
    if (hasBsky && !hasFedi && !hasThreads) return rem.bluesky;
    let remaining = rem.fediverse;
    if (hasBsky) remaining = Math.min(remaining, rem.bluesky);
    if (hasThreads) remaining = Math.min(remaining, rem.threads);
    return remaining;
  }

  function syncUi(s, authState) {
    const accts = authState?.accounts || [];
    const { handle, avatarUrl, destLabel } = summarizeAccountIdentity(accts);

    mainAvatarImg.src = avatarUrl;
    miniAvatarImg.src = avatarUrl;
    authorHandleEl.textContent = handle;
    authorDestEl.textContent = destLabel;

    const extraItems = Array.isArray(s.threadItems) ? s.threadItems : [];
    const wasBodyHidden = Boolean(body.hidden);
    titleEl.textContent = viewingDrafts ? 'Drafts' : (s.replyTo ? 'Reply' : 'New post');
    publishBtn.textContent = s.replyTo ? 'Reply' : 'Post';
    textarea.placeholder = s.replyTo ? 'Write your reply...' : "What's new?";
    cancelBtn.textContent = viewingDrafts ? '← Back' : 'Cancel';
    countsEl.hidden = viewingDrafts;
    body.hidden = viewingDrafts;
    draftsBody.hidden = !viewingDrafts;
    publishBtn.hidden = viewingDrafts;
    saveDraftBtn.hidden = viewingDrafts;
    viewDraftsBtn.classList.toggle('is-active', viewingDrafts);
    if (viewingDrafts) {
      renderDraftsView();
    }

    if (s.replyTo) {
      replyBanner.hidden = false;
      replyBanner.replaceChildren();
      const replyHeader = doc.createElement('div');
      replyHeader.className = 'compose-reply-header';
      const replyLabel = doc.createElement('span');
      replyLabel.className = 'compose-reply-label';
      const replyHandle = String(
        s.replyTo?._meta?.notification?.actor?.handle
        || s.replyTo?.author?.acct
        || s.replyTo?.author?.handle
        || 'post'
      ).replace(/^@/, '');
      replyLabel.textContent = `Replying to @${replyHandle}`;
      const clearReplyBtn = doc.createElement('button');
      clearReplyBtn.type = 'button';
      clearReplyBtn.className = 'compose-reply-clear-btn';
      clearReplyBtn.setAttribute('aria-label', 'Cancel reply and post standalone');
      clearReplyBtn.title = 'Convert to standalone post';
      clearReplyBtn.textContent = '×';
      clearReplyBtn.addEventListener('click', () => clearComposeReply());
      replyHeader.append(replyLabel, clearReplyBtn);
      replyBanner.appendChild(replyHeader);

      const replyCtx = buildSynthesizedReplyContext(s.replyTo);
      const replyCard = createReplyContextBlock(doc, replyCtx);
      if (replyCard) {
        replyCard.removeAttribute('href');
        replyCard.removeAttribute('target');
        replyCard.removeAttribute('rel');
        replyCard.classList.add('is-static-preview');
        replyBanner.appendChild(replyCard);
      }
    } else {
      replyBanner.hidden = true;
      replyBanner.replaceChildren();
    }

    if (textarea.value !== s.text) {
      textarea.value = s.text;
      syncAutoHeight(textarea, 68, 340);
    }

    // Reconcile follow-up thread rows keyed by id so active inputs never lose focus.
    const activeIds = new Set(extraItems.map((it) => it.id));
    for (const [id, entry] of renderedThreadRows.entries()) {
      if (!activeIds.has(id)) {
        entry.rowEl.remove();
        renderedThreadRows.delete(id);
      }
    }
    for (const item of extraItems) {
      let entry = renderedThreadRows.get(item.id);
      if (!entry) {
        entry = createFollowUpRow(item);
        renderedThreadRows.set(item.id, entry);
        threadExtraList.appendChild(entry.rowEl);
      }
      entry.avImg.src = avatarUrl;
      entry.handleEl.textContent = handle;
      if (entry.extraTextarea.value !== (item.text || '')) {
        entry.extraTextarea.value = item.text || '';
        syncAutoHeight(entry.extraTextarea, 52, 260);
      }
    }

    if (!viewingDrafts && wasBodyHidden) {
      syncAllTextareaHeights();
    }

    const canAddThread = Boolean(s.text.trim() || s.mediaAttachments.length > 0 || extraItems.length > 0);
    addThreadRow.hidden = Boolean(s.replyTo);
    addThreadBtn.disabled = !canAddThread;
    mainRail.style.opacity = s.replyTo ? '0.25' : '';

    const hasBsky = s.replyTo ? (s.replyTo.protocol === 'bluesky' || s.replyTo.network === 'bluesky') : accts.some((a) => a.platform === 'bluesky');
    const hasFedi = s.replyTo ? (!hasBsky) : accts.some((a) => a.platform === 'fediverse');
    const hasThreads = !s.replyTo && accts.some((a) => a.platform === 'threads');

    const mainRemaining = minRemainingForItem(s, hasFedi, hasBsky, hasThreads);
    countsEl.textContent = String(mainRemaining);
    countsEl.classList.toggle('is-over-limit', mainRemaining < 0);

    let allWithinLimit = mainRemaining >= 0;
    for (const item of extraItems) {
      const itemRem = minRemainingForItem({ text: item.text || '', spoilerText: '' }, hasFedi, hasBsky, hasThreads);
      if (itemRem < 0) allWithinLimit = false;
      const entry = renderedThreadRows.get(item.id);
      if (entry?.itemCountEl) {
        entry.itemCountEl.textContent = String(itemRem);
        entry.itemCountEl.classList.toggle('is-over-limit', itemRem < 0);
      }
    }

    const overMastodonLimit = hasFedi
      ? ([...(s.text || '')].length > MASTODON_MAX_CHARS || extraItems.some((it) => [...(it.text || '')].length > MASTODON_MAX_CHARS))
      : !allWithinLimit;
    const showAutoSplitNote = mainRemaining < 0 && hasFedi && (hasBsky || hasThreads) && !overMastodonLimit && !s.submitting && !s.error;
    statusLine.classList.toggle('is-info', showAutoSplitNote);
    if (showAutoSplitNote) {
      statusLine.textContent = BRIDGE_AUTOSPLIT_NOTE;
    } else if (!s.submitting && !s.error && statusLine.textContent === BRIDGE_AUTOSPLIT_NOTE) {
      statusLine.textContent = '';
    }

    const hasAnyContent = Boolean(
      s.text.trim().length > 0
      || s.mediaAttachments.length > 0
      || extraItems.some((it) => String(it?.text || '').trim().length > 0)
    );
    saveDraftBtn.disabled = !hasAnyContent || Boolean(s.submitting);

    const ready = (s.text.trim().length > 0 || s.mediaAttachments.length > 0) && !overMastodonLimit && !s.submitting;
    publishBtn.classList.toggle('is-ready', ready);

    const nextMediaSig = s.mediaAttachments.map((m) => `${m.id}:${m.previewUrl || m.url || ''}`).join('|');
    if (nextMediaSig !== lastMediaSignature) {
      lastMediaSignature = nextMediaSig;
      mediaHostEl.replaceChildren(
        s.mediaAttachments.length > 0
          ? createComposerMediaEditor(s.mediaAttachments, {
              onRemove: removeMediaAttachment,
            })
          : doc.createTextNode('')
      );
    }

    syncLinkPreviewForState(s);
    const activeCard = s.mediaAttachments.length === 0 && !s.replyTo && s.linkCard?.url ? s.linkCard : null;
    const nextCardSig = activeCard
      ? `${activeCard.url}\u001f${activeCard.title || ''}\u001f${activeCard.image || ''}\u001f${activeCard.embedUrl || ''}`
      : '';
    if (nextCardSig !== lastRenderedLinkCardSig) {
      lastRenderedLinkCardSig = nextCardSig;
      linkPreviewHostEl.replaceChildren();
      if (activeCard) {
        const cardNode = createEmbedCard(activeCard, {
          compact: true,
          onDismiss: () => dismissComposeLinkCard(activeCard.url),
        });
        if (cardNode) linkPreviewHostEl.appendChild(cardNode);
      }
    }

    if (s.error) {
      statusLine.classList.remove('is-info');
      statusLine.textContent = s.error;
    } else if (!s.submitting && statusLine.textContent !== BRIDGE_AUTOSPLIT_NOTE) {
      statusLine.textContent = '';
    }

    if (s.isOpen && !modal.dialog.open) {
      viewingDrafts = false;
      modal.open();
      syncAllTextareaHeights();
      void refreshDraftsList();
    }
    if (!s.isOpen && modal.dialog.open) {
      viewingDrafts = false;
      clearPendingLinkPreview();
      emojiPicker.close();
      modal.close();
    }
  }

  syncUi(composeStore.get(), authStore.get());
  const unsubCompose = composeStore.subscribe((s) => syncUi(s, authStore.get()));
  const unsubAuth = authStore.subscribe((authState) => syncUi(composeStore.get(), authState));

  return {
    dialog: modal.dialog,
    open: () => modal.open(),
    close: () => closeCompose(),
    destroy: () => {
      clearPendingLinkPreview();
      unsubCompose();
      unsubAuth();
      modal.dialog.remove();
    },
  };
}
