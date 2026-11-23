import {
  animateImage,
  cropProfilePicture,
  deleteSanctuaryImage,
  fetchGenerations,
  generatePortraitStream,
  listProgramImages,
  regenerateImage,
  resolveProgramAvatarUrl,
  resolveSanctuaryMediaUrl,
} from '../../queries/sanctuary.js';
import { DEFAULT_AVATAR_DATA_URI } from '../../constants/avatars.js';
import { prefillFromUserBubble } from '../../state/composeStore.js';
import { bumpProgramAvatarVersion } from '../../state/sanctuary/connection.js';
import { createLoadingState } from '../ui/index.js';
import {
  createClassicModalDialog,
  showAlert,
  showConfirm,
} from './SanctuaryDialog.js';

export const MAX_IMAGES_PER_ROW = 2;

const REGEN_SVG = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="23 4 23 10 17 10"></polyline><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path></svg>`;
const VIDEO_SVG = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="23 7 16 12 23 17 23 7"></polygon><rect x="1" y="5" width="15" height="14" rx="2" ry="2"></rect></svg>`;
const SHARE_SVG = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="18" cy="5" r="3"></circle><circle cx="6" cy="12" r="3"></circle><circle cx="18" cy="19" r="3"></circle><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"></line><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"></line></svg>`;
const DELETE_SVG = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg>`;
const VIEWER_DELETE_SVG = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-right: 6px; display: inline-block; vertical-align: middle;" aria-hidden="true"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg>`;
const VIEWER_PROFILE_SVG = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-right: 6px; display: inline-block; vertical-align: middle;" aria-hidden="true"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle></svg>`;
const PREV_SVG = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="15 18 9 12 15 6"></polyline></svg>`;
const NEXT_SVG = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 18 15 12 9 6"></polyline></svg>`;
const GALLERY_TITLE_SVG = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--primary-accent)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline></svg>`;

function isProfileMediaUrl(url) {
  return /\/profile\.(png|svg|jpe?g|webp)(\?|$)/i.test(String(url || ''));
}

function isVideoMediaUrl(url) {
  return /\.(mp4|webm)(\?|$)/i.test(String(url || ''));
}

function withProgramOwnerQuery(url, ownerId = '') {
  const raw = String(url || '').trim();
  if (!raw) return '';
  if (!ownerId || !raw.startsWith('/images/') || raw.includes('program_id=')) {
    return raw;
  }
  const sep = raw.includes('?') ? '&' : '?';
  return `${raw}${sep}program_id=${encodeURIComponent(ownerId)}`;
}

function stripNodeBase(url, nodeUrl = '') {
  const s = String(url || '');
  if (nodeUrl && s.startsWith(nodeUrl)) {
    return s.slice(nodeUrl.length) || '/';
  }
  return s;
}

function showOverlayOnCard(cardEl, label = '', ariaLabel = label || 'Loading') {
  const doc = globalThis.document;
  let overlay = cardEl.querySelector('.image-loading-overlay');
  if (!overlay) {
    overlay = doc.createElement('div');
    overlay.className = 'image-loading-overlay';
    const spinner = doc.createElement('progress');
    spinner.className = 'loading-spinner';
    spinner.setAttribute('aria-label', ariaLabel);
    overlay.appendChild(spinner);
    if (label) {
      const textEl = doc.createElement('span');
      textEl.className = 'image-loading-text';
      textEl.textContent = label;
      overlay.appendChild(textEl);
    }
    cardEl.appendChild(overlay);
  } else {
    const spinner = overlay.querySelector('.loading-spinner');
    spinner?.setAttribute('aria-label', ariaLabel);
    let textEl = overlay.querySelector('.image-loading-text');
    if (label) {
      if (!textEl) {
        textEl = doc.createElement('span');
        textEl.className = 'image-loading-text';
        overlay.appendChild(textEl);
      }
      textEl.textContent = label;
    } else if (textEl) {
      textEl.remove();
    }
  }
  return overlay;
}

function clearOverlayOnCard(cardEl) {
  cardEl.querySelector('.image-loading-overlay')?.remove();
}

function makeMiniBtn(label, svg, className, onClick) {
  const doc = globalThis.document;
  const btn = doc.createElement('button');
  btn.type = 'button';
  btn.className = className ? `image-action-btn ${className}` : 'image-action-btn';
  btn.setAttribute('aria-label', label);
  btn.title = label;
  btn.innerHTML = svg;
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    void onClick();
  });
  return btn;
}

export function updatePortraitGridToolbar(gridEl, ctx = {}) {
  if (!gridEl) return;
  const deletedCount = Number.parseInt(gridEl.dataset.deletedCount || '0', 10) || 0;
  let toolbar = gridEl.parentElement?.querySelector?.('.portrait-grid-toolbar');
  if (deletedCount <= 0) {
    toolbar?.remove();
    return;
  }
  const doc = globalThis.document;
  if (!toolbar) {
    toolbar = doc.createElement('div');
    toolbar.className = 'portrait-grid-toolbar';
    const btn = doc.createElement('button');
    btn.type = 'button';
    btn.className = 'portrait-batch-reroll-btn portrait-reroll-missing-btn';
    btn.innerHTML = `${REGEN_SVG}<span>Regenerate</span>`;
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      btn.classList.add('is-loading');
      btn.setAttribute('aria-busy', 'true');
      try {
        await regenerateImage({
          session_id: ctx.sessionId || 'default',
          msg_id: gridEl.dataset.msgId,
          prompt: gridEl.dataset.prompt || '',
        });
        await ctx.onRefreshHistory?.();
      } finally {
        btn.disabled = false;
        btn.classList.remove('is-loading');
        btn.removeAttribute('aria-busy');
      }
    });
    toolbar.appendChild(btn);
    gridEl.parentElement?.appendChild(toolbar);
  }
  const btn = toolbar.querySelector('.portrait-reroll-missing-btn');
  if (btn && btn.textContent !== 'Regenerate') {
    btn.innerHTML = `${REGEN_SVG}<span>Regenerate</span>`;
  }
}

export function createVideoCardElement(videoUrl, msgId, role = 'program', speakerId = null, ctx = {}) {
  const doc = globalThis.document;
  const container = doc.createElement('div');
  container.className = 'message-video-container';
  container.dataset.mediaUrl = videoUrl;
  container.dataset.msgId = msgId || '';

  const video = doc.createElement('video');
  video.className = 'chat-generated-video';
  video.src = resolveSanctuaryMediaUrl(videoUrl);
  video.controls = true;
  video.loop = true;
  video.muted = true;
  video.playsInline = true;
  container.appendChild(video);

  const actions = doc.createElement('div');
  actions.className = 'image-actions-overlay';
  actions.appendChild(
    makeMiniBtn('Share video to Fediverse', SHARE_SVG, 'portrait-share-btn', async () => {
      prefillFromUserBubble({
        messageId: msgId,
        text: '',
        media: [{ url: videoUrl, type: 'video', mimeType: 'video/mp4', source: 'sanctuary' }],
      });
      ctx.onOpenCompose?.();
    })
  );
  actions.appendChild(
    makeMiniBtn('Delete video', DELETE_SVG, 'portrait-delete-btn', async () => {
      await deleteSanctuaryImage({
        session_id: ctx.sessionId || 'default',
        image_url: stripNodeBase(videoUrl),
        program_id: speakerId || '',
      });
      await ctx.onRefreshHistory?.();
    })
  );
  container.appendChild(actions);
  return container;
}

export function createPortraitCardElement(imgUrl, prompt, msgId, role = 'program', speakerId = null, ctx = {}) {
  const doc = globalThis.document;
  const container = doc.createElement('div');
  container.className = 'message-image-container';
  container.dataset.mediaUrl = imgUrl;
  container.dataset.prompt = prompt || '';
  container.dataset.msgId = msgId || '';
  if (speakerId) container.dataset.speakerId = speakerId;

  const img = doc.createElement('img');
  img.className = 'chat-generated-image';
  img.src = resolveSanctuaryMediaUrl(imgUrl);
  img.alt = prompt ? `Generated portrait: ${prompt}` : 'Sanctuary image';
  img.loading = 'lazy';
  img.addEventListener('click', () => {
    openMediaLightbox(imgUrl, { ...ctx, msgId, speakerId, prompt });
  });
  container.appendChild(img);

  const actions = doc.createElement('div');
  actions.className = 'image-actions-overlay';

  actions.appendChild(
    makeMiniBtn('Share image to Fediverse', SHARE_SVG, 'portrait-share-btn', async () => {
      prefillFromUserBubble({
        messageId: msgId,
        text: '',
        media: [{ url: imgUrl, type: 'image', altText: prompt || '', source: 'sanctuary' }],
      });
      ctx.onOpenCompose?.();
    })
  );

  if (role === 'program') {
    actions.appendChild(
      makeMiniBtn('Regenerate image', REGEN_SVG, 'portrait-regen-btn', async () => {
        showOverlayOnCard(container, '', 'Regenerate image');
        try {
          await regenerateImage({
            session_id: ctx.sessionId || 'default',
            old_image_url: stripNodeBase(imgUrl),
            prompt: prompt || undefined,
            msg_id: msgId,
            speaker_id: speakerId || undefined,
          });
          await ctx.onRefreshHistory?.();
        } finally {
          clearOverlayOnCard(container);
        }
      })
    );

    actions.appendChild(
      makeMiniBtn('Animate with ComfyUI', VIDEO_SVG, 'portrait-animate-btn', async () => {
        showOverlayOnCard(container, 'Animating...');
        try {
          const res = await animateImage({
            session_id: ctx.sessionId || 'default',
            image_url: stripNodeBase(imgUrl),
            prompt: prompt || '',
            msg_id: msgId,
          });
          const taskId = res?.task_id;
          if (!taskId) return;
          for (let i = 0; i < 60; i += 1) {
            await new Promise((r) => setTimeout(r, 2000));
            const gens = await fetchGenerations();
            const job = (gens?.generations || []).find((g) => g.task_id === taskId);
            if (!job) break;
            if (job.status === 'completed') {
              await ctx.onRefreshHistory?.();
              break;
            }
            if (job.status === 'failed') {
              throw new Error(job.error || 'Video animation failed');
            }
          }
        } finally {
          clearOverlayOnCard(container);
        }
      })
    );

    actions.appendChild(
      makeMiniBtn('Delete image', DELETE_SVG, 'portrait-delete-btn', async () => {
        await deleteSanctuaryImage({
          session_id: ctx.sessionId || 'default',
          image_url: stripNodeBase(imgUrl),
          program_id: speakerId || '',
        });
        container.remove();
        await ctx.onRefreshHistory?.();
      })
    );
  }

  container.appendChild(actions);
  return container;
}

export function createPortraitGrid(mediaList = [], msgId, role, speakerId, sharedPrompt = '', ctx = {}) {
  const doc = globalThis.document;
  const grid = doc.createElement('div');
  grid.className = 'portrait-grid';
  grid.dataset.msgId = msgId || '';
  if (sharedPrompt) grid.dataset.prompt = sharedPrompt;

  const sliced = (Array.isArray(mediaList) ? mediaList : [mediaList]).slice(0, MAX_IMAGES_PER_ROW);
  const isPortraitRow = role === 'program' && sliced.some((m) => String(m?.url || '').includes('/images/portraits/'));
  if (isPortraitRow && sliced.length > 0 && sliced.length < MAX_IMAGES_PER_ROW) {
    grid.dataset.deletedCount = String(MAX_IMAGES_PER_ROW - sliced.length);
  }

  for (const mediaItem of sliced) {
    if (!mediaItem?.url) continue;
    const owner = mediaItem.program_id || (role === 'program' ? speakerId : null);
    if (mediaItem.type === 'video') {
      grid.appendChild(createVideoCardElement(mediaItem.url, msgId, role, owner, ctx));
    } else {
      grid.appendChild(
        createPortraitCardElement(mediaItem.url, mediaItem.prompt || sharedPrompt, msgId, role, owner, ctx)
      );
    }
  }

  return grid;
}

/**
 * Stream NDJSON progressive portrait slots into an active chat container row.
 */
export async function streamPortraitGeneration(chatContainer, {
  sessionId = 'default',
  prompt = '',
  speakerId = null,
  msgId,
  count = MAX_IMAGES_PER_ROW,
  ctx = {},
  createTypingRow = null,
} = {}) {
  const doc = globalThis.document;
  const sentinel = chatContainer.querySelector?.('#bottom-sentinel');
  const typingObj = typeof createTypingRow === 'function' ? createTypingRow() : null;
  const typingRow = typingObj?.row || null;
  if (typingRow) {
    chatContainer.insertBefore(typingRow, sentinel || null);
    chatContainer.scrollTop = chatContainer.scrollHeight;
  }

  const placeholder = doc.createElement('div');
  placeholder.className = 'message-row program-row portrait-stream-placeholder';
  placeholder.dataset.msgId = msgId || '';
  placeholder.dataset.isTransient = 'true';

  if (speakerId) {
    placeholder.dataset.senderId = speakerId;
    const avatarContainer = doc.createElement('div');
    avatarContainer.className = 'avatar-container';
    const avatar = doc.createElement('img');
    avatar.className = 'avatar program-avatar';
    avatar.setAttribute('data-sender-id', speakerId);
    const avatarSrc = ctx.hasProgramProfile?.(speakerId) === false
      ? DEFAULT_AVATAR_DATA_URI
      : (resolveProgramAvatarUrl(speakerId, {
          cacheBuster: ctx.getAvatarVersion?.(speakerId) ?? ctx.cacheBuster,
        }) || DEFAULT_AVATAR_DATA_URI);
    avatar.src = avatarSrc;
    avatar.alt = ctx.programName || speakerId || 'Program';
    avatar.addEventListener('error', () => {
      if (avatar.src !== DEFAULT_AVATAR_DATA_URI) {
        avatar.src = DEFAULT_AVATAR_DATA_URI;
      }
    });
    avatarContainer.appendChild(avatar);
    placeholder.appendChild(avatarContainer);
  }

  const bubblesContainer = doc.createElement('div');
  bubblesContainer.className = 'message-bubbles-container has-portrait-grid';

  const grid = doc.createElement('div');
  grid.className = 'portrait-grid';
  const slots = [];
  for (let i = 0; i < count; i += 1) {
    const slot = doc.createElement('div');
    slot.className = 'message-image-container is-pending-slot';
    showOverlayOnCard(slot, '', `Generating portrait ${i + 1}`);
    slots.push(slot);
    grid.appendChild(slot);
  }
  const bubble = doc.createElement('div');
  bubble.className = 'message program image-message has-portrait-grid';
  bubble.appendChild(grid);
  bubblesContainer.appendChild(bubble);
  placeholder.appendChild(bubblesContainer);

  let placeholderMounted = false;
  if (!typingRow) {
    placeholderMounted = true;
    chatContainer.insertBefore(placeholder, sentinel || null);
    chatContainer.scrollTop = chatContainer.scrollHeight;
  }

  try {
    return await generatePortraitStream(
      {
        session_id: sessionId,
        prompt,
        speaker_id: speakerId,
        msg_id: msgId,
        count,
      },
      {
        onEvent(evt) {
          if (evt.type === 'slot' && typeof evt.index === 'number' && slots[evt.index]) {
            if (!placeholderMounted) {
              placeholderMounted = true;
              typingRow?.remove?.();
              chatContainer.insertBefore(placeholder, chatContainer.querySelector?.('#bottom-sentinel') || null);
            }
            const card = createPortraitCardElement(
              evt.image_url,
              evt.prompt || prompt,
              evt.program_msg_id || msgId,
              'program',
              evt.sender_id || speakerId,
              ctx
            );
            grid.replaceChild(card, slots[evt.index]);
            slots[evt.index] = card;
            chatContainer.scrollTop = chatContainer.scrollHeight;
          }
        },
      }
    );
  } finally {
    typingRow?.remove?.();
    placeholder.remove();
  }
}

function containerContainsPointer(e, el) {
  if (typeof el?.getBoundingClientRect !== 'function') return false;
  const r = el.getBoundingClientRect();
  return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
}

/**
 * Classic frameless full-screen Sanctuary image/video viewer on native top-layer <dialog>
 * with directional arrows, Left/Right keyboard stepping, Delete Image, Make Avatar, and Share.
 */
export function openMediaLightbox(imageUrl, ctx = {}) {
  const doc = globalThis.document;
  let closed = false;
  const targetOwner = ctx.speakerId || ctx.programId || '';
  const isSocial = ctx.source === 'social';

  const seedItems = Array.isArray(ctx.galleryItems) && ctx.galleryItems.length > 0
    ? ctx.galleryItems.map((it) => ({
        url: String(it.url || ''),
        prompt: String(it.prompt || ''),
        msgId: String(it.msgId || ''),
        speakerId: String(it.speakerId || it.owner || targetOwner || ''),
        type: String(it.type || ''),
        mimeType: String(it.mimeType || ''),
      }))
    : Array.from(doc.querySelectorAll('.chat-generated-image, .chat-generated-video')).map((mediaEl) => {
        const container = mediaEl.closest?.('.message-image-container, .message-video-container') || mediaEl.parentElement;
        return {
          url: container?.dataset?.mediaUrl || mediaEl.getAttribute('src') || '',
          prompt: container?.dataset?.prompt || '',
          msgId: container?.dataset?.msgId || '',
          speakerId: container?.dataset?.speakerId || targetOwner || '',
          type: '',
          mimeType: '',
        };
      });

  const items = [];
  const seenUrls = new Set();
  for (const it of seedItems) {
    if (!it.url || (!isSocial && seenUrls.has(it.url))) continue;
    seenUrls.add(it.url);
    items.push(it);
  }

  let currentIdx = -1;
  if (Number.isInteger(ctx.initialIndex) && ctx.initialIndex >= 0 && ctx.initialIndex < items.length) {
    currentIdx = ctx.initialIndex;
  } else if (isSocial) {
    currentIdx = items.findIndex((item) => item.url === imageUrl);
  } else {
    currentIdx = items.findIndex((item) => {
      const owned = withProgramOwnerQuery(item.url, item.speakerId || targetOwner);
      return item.url === imageUrl
        || resolveSanctuaryMediaUrl(item.url) === imageUrl
        || resolveSanctuaryMediaUrl(owned) === imageUrl;
    });
  }
  if (currentIdx === -1) {
    items.unshift({
      url: imageUrl,
      prompt: ctx.prompt || '',
      msgId: ctx.msgId || '',
      speakerId: targetOwner,
      type: String(ctx.type || ''),
      mimeType: String(ctx.mimeType || ''),
    });
    seenUrls.add(imageUrl);
    currentIdx = 0;
  }

  const dialog = doc.createElement('dialog');
  dialog.id = 'sanctuary-lightbox-dialog';
  dialog.className = 'classic-modal-dialog classic-image-viewer-dialog';
  dialog.setAttribute('aria-label', 'Image Viewer');
  dialog.setAttribute('closedby', 'any');

  const closeBtn = doc.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'close-modal';
  closeBtn.setAttribute('aria-label', 'Close image viewer');
  closeBtn.textContent = '×';

  const imgContainer = doc.createElement('div');
  imgContainer.className = 'modal-img-container';

  const img = doc.createElement('img');
  img.id = 'modal-img';
  img.className = 'modal-content';
  img.alt = ctx.prompt || (isSocial ? 'Post attachment' : 'Program Portrait');

  const video = doc.createElement('video');
  video.id = 'modal-video';
  video.className = 'modal-content';
  video.controls = true;
  video.autoplay = true;
  video.loop = true;
  video.muted = true;
  video.playsInline = true;
  video.hidden = true;

  const actions = doc.createElement('div');
  actions.className = 'gallery-actions';

  const deleteBtn = doc.createElement('button');
  deleteBtn.type = 'button';
  deleteBtn.id = 'delete-gallery-btn';
  deleteBtn.className = 'gallery-delete-btn';
  deleteBtn.title = 'Delete image persistently';
  deleteBtn.innerHTML = `${VIEWER_DELETE_SVG}<span>Delete Image</span>`;

  const avatarBtn = doc.createElement('button');
  avatarBtn.type = 'button';
  avatarBtn.id = 'set-profile-btn';
  avatarBtn.className = 'gallery-set-profile-btn';
  avatarBtn.title = 'Make Program avatar';
  avatarBtn.innerHTML = `${VIEWER_PROFILE_SVG}<span>Make Avatar</span>`;

  const shareBtn = doc.createElement('button');
  shareBtn.type = 'button';
  shareBtn.id = 'share-gallery-btn';
  shareBtn.className = 'gallery-share-btn';
  shareBtn.title = 'Share to Fediverse';
  shareBtn.innerHTML = `${SHARE_SVG}<span>Share</span>`;

  actions.append(deleteBtn, avatarBtn, shareBtn);

  const navBar = doc.createElement('div');
  navBar.className = 'gallery-nav-bar';

  const prevBtn = doc.createElement('button');
  prevBtn.type = 'button';
  prevBtn.className = 'gallery-nav-btn prev-btn';
  prevBtn.setAttribute('aria-label', 'Previous image');
  prevBtn.title = 'Previous image';
  prevBtn.innerHTML = PREV_SVG;

  const nextBtn = doc.createElement('button');
  nextBtn.type = 'button';
  nextBtn.className = 'gallery-nav-btn next-btn';
  nextBtn.setAttribute('aria-label', 'Next image');
  nextBtn.title = 'Next image';
  nextBtn.innerHTML = NEXT_SVG;

  navBar.append(prevBtn, nextBtn);
  imgContainer.append(img, video, actions, navBar);
  dialog.append(closeBtn, imgContainer);

  const pausedParents = [];
  function restoreParents() {
    while (pausedParents.length > 0) {
      const parent = pausedParents.pop();
      if (parent?.isConnected !== false) {
        parent.setAttribute('closedby', 'any');
      }
    }
  }

  function closeViewer() {
    restoreParents();
    if (dialog.open) {
      dialog.close();
    } else if (!closed) {
      cleanupOnClose();
    }
  }

  const syncNavControls = () => {
    navBar.hidden = items.length <= 1;
    prevBtn.disabled = items.length <= 1;
    nextBtn.disabled = items.length <= 1;
  };

  const renderActive = () => {
    if (items.length === 0) {
      closeViewer();
      return;
    }
    if (currentIdx < 0 || currentIdx >= items.length) {
      currentIdx = 0;
    }
    const active = items[currentIdx];
    const resolvedSrc = isSocial
      ? active.url
      : resolveSanctuaryMediaUrl(withProgramOwnerQuery(active.url, active.speakerId || targetOwner));
    const isVid = active.type === 'video'
      || active.type === 'gifv'
      || String(active.mimeType || '').startsWith('video/')
      || isVideoMediaUrl(active.url);
    const isProf = isProfileMediaUrl(active.url);
    const isUpload = String(active.url || '').split('?')[0].startsWith('/images/uploads/');
    const activeOwner = active.speakerId || targetOwner;

    img.hidden = isVid;
    video.hidden = !isVid;
    if (isSocial) {
      actions.hidden = true;
      deleteBtn.hidden = true;
      avatarBtn.hidden = true;
      shareBtn.hidden = true;
    } else {
      actions.hidden = false;
      deleteBtn.hidden = isProf;
      avatarBtn.hidden = isProf || isVid || (isUpload && !activeOwner);
      shareBtn.hidden = false;
    }

    if (isVid) {
      video.src = resolvedSrc;
    } else {
      video.pause?.();
      video.removeAttribute?.('src');
      img.src = resolvedSrc;
      img.alt = active.prompt || (isSocial ? 'Post attachment' : 'Program Portrait');
    }
    syncNavControls();
  };

  const stepPrev = () => {
    if (items.length <= 1) return;
    currentIdx = (currentIdx - 1 + items.length) % items.length;
    renderActive();
  };

  const stepNext = () => {
    if (items.length <= 1) return;
    currentIdx = (currentIdx + 1) % items.length;
    renderActive();
  };

  prevBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    stepPrev();
  });

  nextBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    stepNext();
  });

  closeBtn.addEventListener('click', () => closeViewer());

  let pressedOutside = false;
  dialog.addEventListener('pointerdown', (e) => {
    if (dialog.getAttribute('closedby') !== 'any') {
      pressedOutside = false;
      return;
    }
    const openDialogs = doc.querySelectorAll?.('dialog.classic-modal-dialog[open]') || [];
    const isTop = openDialogs.length === 0 || openDialogs[openDialogs.length - 1] === dialog;
    pressedOutside = isTop && e.target === dialog && !containerContainsPointer(e, imgContainer);
  });
  dialog.addEventListener('pointerup', (e) => {
    if (pressedOutside && e.target === dialog && !containerContainsPointer(e, imgContainer)) {
      closeViewer();
    }
    pressedOutside = false;
  });

  const handleKeyDown = (e) => {
    if (closed || !dialog.open) return;
    const openDialogs = doc.querySelectorAll?.('dialog.classic-modal-dialog[open]') || [];
    const isTop = openDialogs.length === 0 || openDialogs[openDialogs.length - 1] === dialog;
    if (!isTop) return;
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      stepPrev();
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      stepNext();
    }
  };
  doc.addEventListener?.('keydown', handleKeyDown);

  function cleanupOnClose() {
    if (closed) return;
    closed = true;
    dialog.returnValue = '';
    video.pause?.();
    video.removeAttribute?.('src');
    doc.removeEventListener?.('keydown', handleKeyDown);
    restoreParents();
    dialog.remove();
  }

  dialog.addEventListener('close', cleanupOnClose);

  shareBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const active = items[currentIdx];
    const url = active?.url || imageUrl;
    const isVid = isVideoMediaUrl(url);
    closeViewer();
    prefillFromUserBubble({
      messageId: active?.msgId || ctx.msgId || null,
      text: '',
      media: [{ url, type: isVid ? 'video' : 'image', ...(isVid ? { mimeType: 'video/mp4' } : {}), altText: active?.prompt || '', source: 'sanctuary' }],
    });
    ctx.onOpenCompose?.();
  });

  avatarBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const active = items[currentIdx];
    closeViewer();
    openAvatarCropModal(active?.url || imageUrl, active?.speakerId || targetOwner || '', ctx.onRefreshHistory);
  });

  deleteBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const active = items[currentIdx];
    if (!active?.url || isProfileMediaUrl(active.url)) return;
    showConfirm('Delete Image', 'Are you sure you want to permanently delete this image from this conversation and the server?', async () => {
      const targetRel = stripNodeBase(active.url);
      let keepMessage = false;
      for (const chatImg of doc.querySelectorAll?.('.message-image-container img') || []) {
        const container = chatImg.closest?.('.message-image-container');
        const imgMedia = stripNodeBase(container?.dataset?.mediaUrl || chatImg.getAttribute?.('src') || '');
        if (imgMedia !== targetRel) continue;
        const scope = container?.closest?.('.portrait-grid') || container?.closest?.('.message');
        if (!scope) continue;
        const siblings = scope.querySelectorAll?.(
          '.message-image-container:not(.is-deleted-slot) img, .message-image-container .image-loading-overlay, .message-video-container video'
        ) || [];
        if (Array.from(siblings).some((el) => !container.contains?.(el))) {
          keepMessage = true;
          break;
        }
      }
      try {
        await deleteSanctuaryImage({
          session_id: ctx.sessionId || 'default',
          image_url: targetRel,
          keep_message: keepMessage,
          program_id: active.speakerId || targetOwner || '',
        });
        items.splice(currentIdx, 1);
        await ctx.onDeleted?.(active.url);
        await ctx.onRefreshHistory?.();
        if (!closed) {
          if (items.length === 0) {
            closeViewer();
          } else {
            currentIdx = Math.min(currentIdx, items.length - 1);
            renderActive();
          }
        }
      } catch (err) {
        showAlert('Delete Failed', err?.message || 'Unable to delete image.');
      }
    });
  });

  renderActive();
  if (!dialog.parentNode && doc.body) {
    doc.body.appendChild(dialog);
  }
  const existingOpen = doc.querySelectorAll?.('dialog.classic-modal-dialog[open]') || [];
  for (const parent of existingOpen) {
    if (parent !== dialog && parent.getAttribute?.('closedby') === 'any') {
      parent.setAttribute('closedby', 'none');
      pausedParents.push(parent);
    }
  }
  dialog.showModal();

  if (!isSocial && !Array.isArray(ctx.galleryItems)) {
    void listProgramImages(targetOwner).then((data) => {
      if (closed || !data) return;
      const byProg = data.images_by_program && typeof data.images_by_program === 'object' ? data.images_by_program : {};
      const list = (targetOwner && Array.isArray(byProg[targetOwner]))
        ? byProg[targetOwner]
        : (Array.isArray(data.images) ? data.images : []);
      const owners = data.image_owners || {};
      let added = false;
      for (const u of list) {
        if (!u || isProfileMediaUrl(u) || seenUrls.has(u)) continue;
        seenUrls.add(u);
        items.push({ url: u, prompt: '', msgId: '', speakerId: owners[u] || targetOwner });
        added = true;
      }
      if (added) syncNavControls();
    }).catch(() => {});
  }

  return {
    dialog,
    close: closeViewer,
  };
}

/**
 * Open the classic Sanctuary media viewer directly to the Program's most recent image.
 */
export async function openLatestProgramMedia({
  programId = '',
  programName = 'Program',
  sessionId = 'default',
  onOpenCompose,
  onRefreshHistory,
} = {}) {
  let data;
  try {
    data = await listProgramImages(programId);
  } catch (err) {
    showAlert('Gallery Unavailable', err?.message || 'Unable to load generated images.');
    return null;
  }

  const byProg = data?.images_by_program && typeof data.images_by_program === 'object' ? data.images_by_program : {};
  const owners = data?.image_owners && typeof data.image_owners === 'object' ? data.image_owners : {};
  const rawUrls = (programId && Array.isArray(byProg[programId]))
    ? byProg[programId]
    : (Array.isArray(data?.images) ? data.images : []);

  const galleryItems = [];
  const seen = new Set();
  for (const url of rawUrls) {
    if (!url || isProfileMediaUrl(url) || seen.has(url)) continue;
    seen.add(url);
    galleryItems.push({ url, speakerId: owners[url] || programId, prompt: '', msgId: '' });
  }

  if (galleryItems.length === 0) {
    showAlert('No Media', 'No portraits or generated images exist for this character yet.');
    return null;
  }

  return openMediaLightbox(galleryItems[0].url, {
    sessionId,
    programId,
    programName,
    speakerId: galleryItems[0].speakerId || programId,
    onOpenCompose,
    onRefreshHistory,
    galleryItems,
  });
}

/**
 * Native <dialog> gallery browser backed by GET /list_images for inspecting generated portraits,
 * cross-program generations, and uploaded media.
 */
export function openProgramGalleryModal({
  programId = '',
  programName = 'Program',
  sessionId = 'default',
  onOpenCompose,
  onRefreshHistory,
} = {}) {
  const doc = globalThis.document;
  let closed = false;
  let activeTab = 'program';
  let loading = true;
  let loadError = '';
  let galleryData = { images: [], images_by_program: {}, image_owners: {}, uploads: [] };

  const modal = createClassicModalDialog({
    id: 'sanctuary-gallery-dialog',
    maxWidth: '720px',
    onClose: () => {
      closed = true;
      modal.dialog.remove();
    },
  });

  const heading = doc.createElement('h3');
  heading.id = modal.titleId;
  heading.className = 'classic-modal-title';
  heading.innerHTML = `${GALLERY_TITLE_SVG}<span>Image Gallery</span>`;

  const descriptorEl = doc.createElement('p');
  descriptorEl.className = 'classic-modal-desc';
  descriptorEl.textContent = `Generated portraits, animated media, and uploaded attachments for ${programName || programId || 'Sanctuary'}.`;

  const tabBar = doc.createElement('div');
  tabBar.className = 'classic-modal-tabs';
  const programTabBtn = doc.createElement('button');
  programTabBtn.type = 'button';
  programTabBtn.className = 'modal-tab-btn active';
  programTabBtn.dataset.galleryTab = 'program';
  programTabBtn.textContent = programName || programId || 'Program';

  const allTabBtn = doc.createElement('button');
  allTabBtn.type = 'button';
  allTabBtn.className = 'modal-tab-btn';
  allTabBtn.dataset.galleryTab = 'all';
  allTabBtn.textContent = 'All Programs';

  const uploadsTabBtn = doc.createElement('button');
  uploadsTabBtn.type = 'button';
  uploadsTabBtn.className = 'modal-tab-btn';
  uploadsTabBtn.dataset.galleryTab = 'uploads';
  uploadsTabBtn.textContent = 'Uploads';

  tabBar.append(programTabBtn, allTabBtn, uploadsTabBtn);

  const bodyHost = doc.createElement('div');
  bodyHost.className = 'classic-modal-scroll-body';

  modal.card.append(heading, descriptorEl, tabBar, bodyHost);

  function buildItemsForTab() {
    const owners = galleryData.image_owners || {};
    const byProg = galleryData.images_by_program || {};

    if (activeTab === 'program') {
      const urls = (programId && Array.isArray(byProg[programId]))
        ? byProg[programId]
        : (Array.isArray(galleryData.images) ? galleryData.images : []);
      return urls.map((url) => ({ url, speakerId: owners[url] || programId, prompt: '', msgId: '' }));
    }

    if (activeTab === 'all') {
      const combined = [];
      const seen = new Set();
      for (const [owner, urls] of Object.entries(byProg)) {
        if (!Array.isArray(urls)) continue;
        for (const url of urls) {
          if (!url || seen.has(url)) continue;
          seen.add(url);
          combined.push({ url, speakerId: owners[url] || owner, prompt: '', msgId: '' });
        }
      }
      return combined;
    }

    const uploads = Array.isArray(galleryData.uploads) ? galleryData.uploads : [];
    return uploads.map((url) => ({ url, speakerId: owners[url] || programId, prompt: '', msgId: '' }));
  }

  function renderGalleryBody() {
    if (closed) return;
    programTabBtn.classList.toggle('active', activeTab === 'program');
    allTabBtn.classList.toggle('active', activeTab === 'all');
    uploadsTabBtn.classList.toggle('active', activeTab === 'uploads');
    bodyHost.replaceChildren();

    if (loading) {
      bodyHost.appendChild(createLoadingState('Loading gallery media…', { doc, compact: true }));
      return;
    }

    if (loadError) {
      const errEl = doc.createElement('p');
      errEl.className = 'empty-state';
      errEl.textContent = loadError;
      bodyHost.appendChild(errEl);
      return;
    }

    const items = buildItemsForTab();
    if (items.length === 0) {
      const empty = doc.createElement('p');
      empty.className = 'empty-state';
      empty.textContent = activeTab === 'uploads'
        ? 'No uploaded attachments yet.'
        : `No generated images for ${activeTab === 'program' ? (programName || 'this Program') : 'any Program'} yet.`;
      bodyHost.appendChild(empty);
      return;
    }

    const grid = doc.createElement('div');
    grid.className = 'sanctuary-gallery-grid';

    for (const item of items) {
      const cell = doc.createElement('button');
      cell.type = 'button';
      cell.className = 'sanctuary-gallery-item';
      const resolvedSrc = resolveSanctuaryMediaUrl(withProgramOwnerQuery(item.url, item.speakerId));
      const isVid = isVideoMediaUrl(item.url);
      cell.setAttribute('aria-label', isVid ? 'Open video preview' : 'Open image preview');

      if (isVid) {
        const vid = doc.createElement('video');
        vid.src = resolvedSrc;
        vid.muted = true;
        vid.playsInline = true;
        vid.preload = 'metadata';
        cell.appendChild(vid);

        const vidTag = doc.createElement('span');
        vidTag.className = 'sanctuary-gallery-owner-badge';
        vidTag.textContent = 'VIDEO';
        cell.appendChild(vidTag);
      } else {
        const thumb = doc.createElement('img');
        thumb.src = resolvedSrc;
        thumb.alt = `${item.speakerId || programName || 'Sanctuary'} gallery media`;
        thumb.loading = 'lazy';
        cell.appendChild(thumb);
      }

      if (activeTab === 'all' && item.speakerId) {
        const badge = doc.createElement('span');
        badge.className = 'sanctuary-gallery-owner-badge';
        badge.textContent = item.speakerId;
        cell.appendChild(badge);
      }

      cell.addEventListener('click', () => {
        openMediaLightbox(item.url, {
          sessionId,
          programId,
          programName,
          speakerId: item.speakerId || programId,
          onOpenCompose: () => {
            modal.close();
            onOpenCompose?.();
          },
          onRefreshHistory,
          galleryItems: items,
          fromGalleryModal: true,
          onDeleted: () => loadGallery(),
        });
      });

      grid.appendChild(cell);
    }

    bodyHost.appendChild(grid);
  }

  async function loadGallery() {
    loading = true;
    loadError = '';
    renderGalleryBody();
    try {
      const res = await listProgramImages(programId);
      if (closed) return;
      galleryData = {
        images: Array.isArray(res?.images) ? res.images : [],
        images_by_program: res?.images_by_program && typeof res.images_by_program === 'object' ? res.images_by_program : {},
        image_owners: res?.image_owners && typeof res.image_owners === 'object' ? res.image_owners : {},
        uploads: Array.isArray(res?.uploads) ? res.uploads : [],
      };
    } catch (err) {
      if (!closed) {
        loadError = err?.message || 'Unable to load image gallery.';
      }
    } finally {
      loading = false;
      if (!closed) renderGalleryBody();
    }
  }

  for (const [btn, tab] of [
    [programTabBtn, 'program'],
    [allTabBtn, 'all'],
    [uploadsTabBtn, 'uploads'],
  ]) {
    btn.addEventListener('click', () => {
      activeTab = tab;
      renderGalleryBody();
    });
  }

  modal.open();
  void loadGallery();
  return modal;
}

export function openAvatarCropModal(sourceUrl, programId, onSaved) {
  const doc = globalThis.document;
  let cropperInstance = null;
  const modal = createClassicModalDialog({
    id: 'crop-modal',
    title: 'Crop Program Avatar',
    maxWidth: 'min(92dvw, 520px)',
    onClose: () => {
      cropperInstance?.destroy?.();
      cropperInstance = null;
      modal.dialog.remove();
    },
  });
  modal.card.style.width = 'fit-content';
  modal.card.style.minWidth = '280px';
  modal.card.style.alignItems = 'center';
  if (modal.headingEl) {
    modal.headingEl.style.alignSelf = 'stretch';
  }

  const wrap = doc.createElement('div');
  wrap.className = 'avatar-crop-stage';

  const img = doc.createElement('img');
  img.alt = 'Crop avatar';
  img.className = 'avatar-crop-source';
  wrap.appendChild(img);

  const footer = doc.createElement('div');
  footer.className = 'classic-modal-footer-end';
  footer.style.width = '100%';

  const cancelBtn = doc.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'edit-btn edit-cancel-btn';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', () => modal.close());

  const saveBtn = doc.createElement('button');
  saveBtn.type = 'button';
  saveBtn.className = 'edit-btn edit-save-btn';
  saveBtn.textContent = 'Save Avatar';
  saveBtn.addEventListener('click', async () => {
    saveBtn.disabled = true;
    try {
      const rawBox = cropperInstance?.getData?.(true);
      let box = rawBox;
      if (!box || Number(box.width) <= 1 || Number(box.height) <= 1) {
        const nw = Number(img.naturalWidth || img.width || 512);
        const nh = Number(img.naturalHeight || img.height || 512);
        const size = Math.max(1, Math.min(nw, nh));
        box = {
          x: Math.max(0, Math.round((nw - size) / 2)),
          y: Math.max(0, Math.round((nh - size) / 2)),
          width: size,
          height: size,
        };
      }
      const res = await cropProfilePicture({
        source_image: stripNodeBase(sourceUrl),
        x: Math.round(box.x || 0),
        y: Math.round(box.y || 0),
        width: Math.max(1, Math.round(box.width || 256)),
        height: Math.max(1, Math.round(box.height || 256)),
        program_id: programId || undefined,
      });
      const savedProgId = res?.program_id || programId || '';
      bumpProgramAvatarVersion(savedProgId);
      modal.close();
      await onSaved?.(savedProgId);
    } catch (err) {
      showAlert('Save Failed', err?.message || 'Unable to crop profile picture.');
    } finally {
      saveBtn.disabled = false;
    }
  });

  const fitStageAndInitCropper = () => {
    if (cropperInstance || modal.dialog.isConnected === false) return;
    const nw = Number(img.naturalWidth || img.width || 0);
    const nh = Number(img.naturalHeight || img.height || 0);
    if (nw > 0 && nh > 0) {
      const maxW = Math.max(220, Math.min((Number(globalThis.innerWidth) || 520) - 64, 460));
      const maxH = Math.max(220, Math.round((Number(globalThis.innerHeight) || 760) * 0.6));
      const scale = Math.min(maxW / nw, maxH / nh);
      const stageW = Math.max(1, Math.round(nw * scale));
      const stageH = Math.max(1, Math.round(nh * scale));
      wrap.style.width = `${stageW}px`;
      wrap.style.height = `${stageH}px`;
      img.style.width = '100%';
      img.style.height = '100%';
    }
    if (typeof globalThis.Cropper === 'function') {
      cropperInstance = new globalThis.Cropper(img, {
        aspectRatio: 1,
        viewMode: 1,
        dragMode: 'move',
        autoCropArea: 0.9,
        background: false,
        responsive: true,
        checkOrientation: false,
      });
    }
  };

  img.addEventListener('load', fitStageAndInitCropper, { once: true });
  img.addEventListener('error', fitStageAndInitCropper, { once: true });
  img.src = resolveSanctuaryMediaUrl(withProgramOwnerQuery(sourceUrl, programId));

  footer.appendChild(cancelBtn);
  footer.appendChild(saveBtn);
  modal.card.appendChild(wrap);
  modal.card.appendChild(footer);
  modal.open();

  if ((img.complete && Number(img.naturalWidth) > 0) || !('complete' in img)) {
    fitStageAndInitCropper();
  }
}
