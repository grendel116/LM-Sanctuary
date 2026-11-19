/**
 * Native <dialog> modal shell (no redundant role="dialog" or aria-modal).
 */

const CLOSE_ICON_SVG = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>`;

function pointerIsOutsideDialog(e, dialog) {
  if (typeof dialog.getBoundingClientRect !== 'function') return false;
  const r = dialog.getBoundingClientRect();
  return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
}

/**
 * Create a modal dialog backed by HTMLDialogElement.showModal().
 */
export function createModalShell({
  id,
  title,
  closedBy = 'any',
  className = '',
  body = null,
  footer = null,
  onClose,
} = {}) {
  const doc = globalThis.document;
  const dialog = doc.createElement('dialog');
  dialog.id = id;
  dialog.className = ['ui-modal-dialog', className].filter(Boolean).join(' ');
  dialog.setAttribute('aria-labelledby', `${id}-title`);
  if (closedBy) {
    dialog.setAttribute('closedby', closedBy);
  }

  const headerEl = doc.createElement('div');
  headerEl.className = 'ui-modal-header';

  const headingEl = doc.createElement('h2');
  headingEl.id = `${id}-title`;
  headingEl.className = 'ui-modal-title';
  headingEl.textContent = String(title || '');

  const closeBtn = doc.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'ui-icon-btn ui-modal-close';
  closeBtn.setAttribute('aria-label', 'Close');
  closeBtn.innerHTML = `<span aria-hidden="true">${CLOSE_ICON_SVG}</span>`;
  closeBtn.addEventListener('click', () => close());

  headerEl.appendChild(headingEl);
  headerEl.appendChild(closeBtn);

  const bodyEl = doc.createElement('div');
  bodyEl.className = 'ui-modal-body';
  if (body) {
    bodyEl.appendChild(body);
  }

  dialog.appendChild(headerEl);
  dialog.appendChild(bodyEl);

  if (footer) {
    const footerEl = doc.createElement('div');
    footerEl.className = 'ui-modal-footer';
    footerEl.appendChild(footer);
    dialog.appendChild(footerEl);
  }

  if (closedBy === 'any' && !('closedBy' in (globalThis.HTMLDialogElement?.prototype || {}))) {
    let pressedOutside = false;
    dialog.addEventListener('pointerdown', (e) => {
      pressedOutside = pointerIsOutsideDialog(e, dialog);
    });
    dialog.addEventListener('pointerup', (e) => {
      if (pressedOutside && pointerIsOutsideDialog(e, dialog)) {
        close();
      }
      pressedOutside = false;
    });
  }

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

  return { dialog, headerEl, bodyEl, closeBtn, open, close, setTitle };
}
