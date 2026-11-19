import { prefillFromUserBubble } from '../state/composeStore.js';

const SHARE_ICON_SVG = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="18" cy="5" r="3"></circle><circle cx="6" cy="12" r="3"></circle><circle cx="18" cy="19" r="3"></circle><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"></line><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"></line></svg>`;

/**
 * Action button rendered in the 4th trailing slot of user chat bubbles,
 * opening composeModal pre-filled with the user's raw text and turn media.
 */
export function createFediverseShareButton({
  messageId = null,
  getRawText,
  getMedia,
  onOpenCompose,
} = {}) {
  const doc = globalThis.document;
  const btn = doc.createElement('button');
  btn.type = 'button';
  btn.className = 'action-icon-btn fediverse-share-btn';
  btn.setAttribute('aria-label', 'Share to Fediverse');
  btn.title = 'Share to Fediverse';
  btn.innerHTML = SHARE_ICON_SVG;

  btn.addEventListener('click', (event) => {
    event?.stopPropagation?.();
    const rawText = typeof getRawText === 'function' ? getRawText() : '';
    const media = typeof getMedia === 'function' ? getMedia() : [];
    prefillFromUserBubble({
      messageId,
      text: rawText,
      media,
    });
    if (typeof onOpenCompose === 'function') {
      onOpenCompose();
    }
    if (typeof globalThis.dispatchEvent === 'function' && typeof CustomEvent === 'function') {
      globalThis.dispatchEvent(new CustomEvent('sanctuary:open-compose', { detail: { messageId } }));
    }
  });

  return btn;
}
