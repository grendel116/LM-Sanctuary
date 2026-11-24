import { requestNodeRaw } from '../../queries/sanctuary.js';

const CLOSE_MODAL_HANDLER_BOUND = new WeakSet();

function notifyOverlayChange(doc) {
  const dispatch = () => {
    try {
      doc?.dispatchEvent?.(new Event('sanctuary:overlay-change'));
    } catch {
      // Ignore environments without Event constructor
    }
  };
  dispatch();
  if (typeof queueMicrotask === 'function') {
    queueMicrotask(dispatch);
  }
}

function cardBoundsContainPointer(e, cardEl) {
  if (typeof cardEl?.getBoundingClientRect !== 'function') return false;
  const r = cardEl.getBoundingClientRect();
  return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
}

/**
 * Create a native top-layer <dialog> styled with classic LM-Sanctuary .modal-card classes.
 * Never adds redundant role="dialog" or aria-modal attributes.
 */
export function createClassicModalDialog({
  id = 'sanctuary-modal',
  title = '',
  maxWidth = '580px',
  closedBy = 'any',
  onClose,
} = {}) {
  const doc = globalThis.document;
  const dialog = doc.createElement('dialog');
  dialog.id = id;
  dialog.className = 'classic-modal-dialog';
  const titleId = `${id}-title`;
  dialog.setAttribute('aria-labelledby', titleId);
  if (closedBy) {
    dialog.setAttribute('closedby', closedBy);
  }

  const card = doc.createElement('div');
  card.className = 'modal-card';
  card.style.maxWidth = maxWidth;
  card.style.width = '100%';
  card.style.textAlign = 'left';
  card.style.alignItems = 'stretch';

  const closeBtn = doc.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'close-modal-btn';
  closeBtn.setAttribute('aria-label', 'Close');
  closeBtn.textContent = '×';
  closeBtn.addEventListener('click', () => close());
  card.appendChild(closeBtn);

  let headingEl = null;
  if (title) {
    headingEl = doc.createElement('h3');
    headingEl.id = titleId;
    headingEl.className = 'classic-modal-title';
    headingEl.textContent = String(title);
    card.appendChild(headingEl);
  }

  dialog.appendChild(card);

  const pausedParents = [];

  if (closedBy === 'any' && !('closedBy' in (globalThis.HTMLDialogElement?.prototype || {}))) {
    let pressedOutside = false;
    dialog.addEventListener('pointerdown', (e) => {
      const openDialogs = doc.querySelectorAll?.('dialog.classic-modal-dialog[open]') || [];
      const isTop = openDialogs.length === 0 || openDialogs[openDialogs.length - 1] === dialog;
      pressedOutside = isTop && e.target === dialog && !cardBoundsContainPointer(e, card);
    });
    dialog.addEventListener('pointerup', (e) => {
      if (pressedOutside && e.target === dialog && !cardBoundsContainPointer(e, card)) {
        close();
      }
      pressedOutside = false;
    });
  }

  function restoreParents() {
    while (pausedParents.length > 0) {
      const parent = pausedParents.pop();
      if (parent?.isConnected !== false) {
        parent.setAttribute('closedby', 'any');
      }
    }
  }

  if (!CLOSE_MODAL_HANDLER_BOUND.has(dialog)) {
    CLOSE_MODAL_HANDLER_BOUND.add(dialog);
    dialog.addEventListener('close', () => {
      dialog.returnValue = '';
      restoreParents();
      onClose?.();
      notifyOverlayChange(doc);
    });
  }

  function open() {
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
    if (!dialog.open) {
      dialog.showModal();
    }
    notifyOverlayChange(doc);
  }

  function close() {
    restoreParents();
    if (dialog.open) {
      dialog.close();
      notifyOverlayChange(doc);
    }
  }

  return {
    dialog,
    card,
    headingEl,
    titleId,
    closeBtn,
    open,
    close,
  };
}

/**
 * Classic Alert dialog replacing window.alert().
 */
export function showAlert(title, message, onClose = null) {
  const doc = globalThis.document;
  const modal = createClassicModalDialog({
    id: `custom-alert-${Date.now()}`,
    maxWidth: '400px',
    closedBy: 'closerequest',
    onClose: () => {
      modal.dialog.remove();
      onClose?.();
    },
  });
  modal.card.style.textAlign = 'center';
  modal.card.style.alignItems = 'center';

  if (title) {
    const h3 = doc.createElement('h3');
    h3.id = modal.titleId;
    h3.className = 'classic-dialog-title';
    h3.textContent = String(title);
    modal.card.appendChild(h3);
  }

  const msgEl = doc.createElement('div');
  msgEl.className = 'classic-dialog-message';
  msgEl.textContent = String(message || '');
  modal.card.appendChild(msgEl);

  const btnRow = doc.createElement('div');
  btnRow.className = 'classic-dialog-actions';
  const okBtn = doc.createElement('button');
  okBtn.type = 'button';
  okBtn.className = 'edit-btn edit-save-btn';
  okBtn.style.minWidth = '100px';
  okBtn.textContent = 'OK';
  okBtn.setAttribute('autofocus', '');
  okBtn.addEventListener('click', () => modal.close());
  btnRow.appendChild(okBtn);
  modal.card.appendChild(btnRow);

  modal.open();
  okBtn.focus?.();
  return modal;
}

/**
 * Classic Confirm dialog replacing window.confirm(). Puts autofocus on Cancel.
 */
export function showConfirm(title, message, onConfirm, onCancel = null) {
  const doc = globalThis.document;
  let handled = false;
  const modal = createClassicModalDialog({
    id: `custom-confirm-${Date.now()}`,
    maxWidth: '400px',
    closedBy: 'closerequest',
    onClose: () => {
      modal.dialog.remove();
      if (!handled) onCancel?.();
    },
  });
  modal.card.style.textAlign = 'center';
  modal.card.style.alignItems = 'center';

  if (title) {
    const h3 = doc.createElement('h3');
    h3.id = modal.titleId;
    h3.className = 'classic-dialog-title';
    h3.textContent = String(title);
    modal.card.appendChild(h3);
  }

  const msgEl = doc.createElement('div');
  msgEl.className = 'classic-dialog-message';
  msgEl.textContent = String(message || '');
  modal.card.appendChild(msgEl);

  const btnRow = doc.createElement('div');
  btnRow.className = 'classic-dialog-actions';

  const cancelBtn = doc.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'edit-btn edit-cancel-btn';
  cancelBtn.style.minWidth = '100px';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.setAttribute('autofocus', '');
  cancelBtn.addEventListener('click', () => {
    handled = true;
    modal.close();
    onCancel?.();
  });

  const confirmBtn = doc.createElement('button');
  confirmBtn.type = 'button';
  confirmBtn.className = 'edit-btn edit-save-btn';
  confirmBtn.style.minWidth = '100px';
  confirmBtn.textContent = 'Confirm';
  confirmBtn.addEventListener('click', () => {
    handled = true;
    modal.close();
    void onConfirm?.();
  });

  btnRow.append(cancelBtn, confirmBtn);
  modal.card.appendChild(btnRow);
  modal.open();
  cancelBtn.focus?.();
  return modal;
}

/**
 * Classic text Prompt dialog replacing window.prompt().
 */
export function showPrompt(title, message, defaultValue = '', onConfirm, onCancel = null, opts = {}) {
  const doc = globalThis.document;
  let submitted = false;
  const modal = createClassicModalDialog({
    id: `custom-prompt-${Date.now()}`,
    maxWidth: '420px',
    closedBy: 'closerequest',
    onClose: () => {
      modal.dialog.remove();
      if (!submitted) onCancel?.();
    },
  });

  const h3 = doc.createElement('h3');
  h3.id = modal.titleId;
  h3.className = 'classic-dialog-title';
  h3.textContent = String(title || 'Input');

  const msgP = doc.createElement('p');
  msgP.textContent = String(message || '');

  const input = doc.createElement('input');
  input.type = opts?.inputType ? String(opts.inputType) : 'text';
  input.className = 'onboarding-input';
  if (opts?.placeholder) {
    input.placeholder = String(opts.placeholder);
  }
  input.value = String(defaultValue || '');
  input.style.fontSize = '0.9rem';
  input.style.marginBottom = '14px';
  input.setAttribute('autofocus', '');

  const btnRow = doc.createElement('div');
  btnRow.className = 'classic-dialog-actions';

  const cancelBtn = doc.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'edit-btn edit-cancel-btn';
  cancelBtn.style.minWidth = '100px';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', () => {
    submitted = true;
    modal.close();
    onCancel?.();
  });

  const submitBtn = doc.createElement('button');
  submitBtn.type = 'button';
  submitBtn.className = 'edit-btn edit-save-btn';
  submitBtn.style.minWidth = '100px';
  submitBtn.textContent = opts?.confirmLabel ? String(opts.confirmLabel) : 'Confirm';

  const finish = () => {
    submitted = true;
    const val = input.value;
    modal.close();
    void onConfirm?.(val);
  };
  submitBtn.addEventListener('click', finish);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      finish();
    }
  });

  btnRow.append(cancelBtn, submitBtn);
  modal.card.append(h3, msgP, input, btnRow);
  modal.open();
  input.focus?.();
  return modal;
}

/**
 * Classic multi-line Textarea Prompt dialog for Data Bank text ingestion.
 */
export function showTextareaPrompt(title, message, defaultValue = '', onConfirm, onCancel = null) {
  const doc = globalThis.document;
  let submitted = false;
  const modal = createClassicModalDialog({
    id: `custom-textarea-prompt-${Date.now()}`,
    maxWidth: '600px',
    closedBy: 'closerequest',
    onClose: () => {
      modal.dialog.remove();
      if (!submitted) onCancel?.();
    },
  });

  const h3 = doc.createElement('h3');
  h3.id = modal.titleId;
  h3.className = 'classic-dialog-title';
  h3.textContent = String(title || 'Text Input');

  const msgP = doc.createElement('p');
  msgP.textContent = String(message || '');

  const textarea = doc.createElement('textarea');
  textarea.className = 'onboarding-input';
  textarea.rows = 6;
  textarea.style.minHeight = '160px';
  textarea.style.marginBottom = '14px';
  textarea.value = String(defaultValue || '');
  textarea.setAttribute('autofocus', '');

  const btnRow = doc.createElement('div');
  btnRow.className = 'classic-dialog-actions';

  const cancelBtn = doc.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'edit-btn edit-cancel-btn';
  cancelBtn.style.minWidth = '100px';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', () => {
    submitted = true;
    modal.close();
    onCancel?.();
  });

  const submitBtn = doc.createElement('button');
  submitBtn.type = 'button';
  submitBtn.className = 'edit-btn edit-save-btn';
  submitBtn.style.minWidth = '100px';
  submitBtn.textContent = 'Confirm';

  const finish = () => {
    submitted = true;
    const val = textarea.value;
    modal.close();
    void onConfirm?.(val);
  };
  submitBtn.addEventListener('click', finish);
  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      finish();
    }
  });

  btnRow.append(cancelBtn, submitBtn);
  modal.card.append(h3, msgP, textarea, btnRow);
  modal.open();
  textarea.focus?.();
  return modal;
}

/**
 * Download an authenticated Sanctuary node file (/api/programs/.../export, lorebook, or .ics)
 * via Blob so Basic Auth headers are forwarded when connecting over LAN/Tailscale.
 */
export async function downloadNodeFile(path, defaultFilename = 'download.json') {
  try {
    let fileHandle = null;
    if (typeof globalThis.window?.showSaveFilePicker === 'function') {
      const isIcs = String(defaultFilename).toLowerCase().endsWith('.ics');
      const types = isIcs
        ? [{ description: 'Calendar Files', accept: { 'text/calendar': ['.ics'] } }]
        : [{ description: 'JSON Files', accept: { 'application/json': ['.json'] } }];
      try {
        fileHandle = await globalThis.window.showSaveFilePicker({
          suggestedName: defaultFilename,
          types,
        });
      } catch (err) {
        if (err?.name === 'AbortError') return false;
      }
    }

    const res = await requestNodeRaw(path, { timeoutMs: 30000 });
    if (!res.ok) {
      let errMsg = `Server responded with status ${res.status}`;
      try {
        const data = await res.json();
        if (data?.error) errMsg = data.error;
      } catch {
        // Ignore non-JSON error bodies
      }
      showAlert('Export Failed', errMsg);
      return false;
    }

    const blob = await res.blob();
    if (fileHandle) {
      const writable = await fileHandle.createWritable();
      await writable.write(blob);
      await writable.close();
      return true;
    }

    let filename = defaultFilename;
    const disp = res.headers?.get?.('Content-Disposition');
    if (disp && disp.includes('filename=')) {
      const m = disp.match(/filename=["']?([^"';]+)["']?/);
      if (m?.[1]) filename = m[1].trim();
    }

    if (typeof globalThis.URL?.createObjectURL === 'function' && globalThis.document?.body) {
      const blobUrl = globalThis.URL.createObjectURL(blob);
      const a = globalThis.document.createElement('a');
      a.style.display = 'none';
      a.href = blobUrl;
      a.download = filename;
      globalThis.document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => globalThis.URL?.revokeObjectURL?.(blobUrl), 2000);
    }
    return true;
  } catch (err) {
    showAlert('Export Failed', err?.message || 'Unable to export file.');
    return false;
  }
}

export function isDavyActiveUser(activeUser = '') {
  return String(activeUser || '').trim().toLowerCase() === 'davy';
}
