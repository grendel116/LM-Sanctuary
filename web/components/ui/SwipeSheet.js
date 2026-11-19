/**
 * Native <dialog> slide-over drawer (right edge) and bottom action sheet.
 */

const CLOSE_ICON_SVG = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>`;

export function createSwipeSheet({
  id,
  title,
  side = 'right',
  className = '',
  body = null,
  onClose,
} = {}) {
  const doc = globalThis.document;
  const dialog = doc.createElement('dialog');
  dialog.id = id;
  dialog.className = ['ui-sheet', `ui-sheet--${side}`, className].filter(Boolean).join(' ');
  dialog.setAttribute('aria-labelledby', `${id}-title`);

  const panelEl = doc.createElement('div');
  panelEl.className = 'ui-sheet-panel';

  const headerEl = doc.createElement('div');
  headerEl.className = 'ui-sheet-header';

  const headingEl = doc.createElement('h2');
  headingEl.id = `${id}-title`;
  headingEl.className = 'ui-sheet-title';
  headingEl.textContent = String(title || '');

  const closeBtn = doc.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'ui-icon-btn ui-sheet-close';
  closeBtn.setAttribute('aria-label', 'Close panel');
  closeBtn.setAttribute('autofocus', '');
  closeBtn.innerHTML = `<span aria-hidden="true">${CLOSE_ICON_SVG}</span>`;
  closeBtn.addEventListener('click', () => close());

  headerEl.appendChild(headingEl);
  headerEl.appendChild(closeBtn);

  const bodyEl = doc.createElement('div');
  bodyEl.className = 'ui-sheet-body';
  if (body) {
    bodyEl.appendChild(body);
  }

  panelEl.appendChild(headerEl);
  panelEl.appendChild(bodyEl);
  dialog.appendChild(panelEl);

  dialog.addEventListener('click', (event) => {
    if (!panelEl.contains(event.target)) {
      close();
    }
  });

  dialog.addEventListener('close', () => {
    dialog.returnValue = '';
    onClose?.();
  });

  function open() {
    if (!dialog.open) {
      dialog.showModal();
    }
  }

  function close() {
    if (dialog.open) {
      dialog.close();
    }
  }

  function setTitle(nextTitle) {
    headingEl.textContent = String(nextTitle || '');
  }

  return { dialog, panelEl, bodyEl, open, close, setTitle };
}
