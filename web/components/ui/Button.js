/**
 * Native accessible <button> primitive.
 */

export function createButton({
  label = '',
  iconSvg = '',
  ariaLabel = '',
  title = '',
  variant = 'ghost',
  className = '',
  type = 'button',
  disabled = false,
  autofocus = false,
  dataset = {},
  onClick,
} = {}) {
  const doc = globalThis.document;
  const btn = doc.createElement('button');
  btn.type = type;
  btn.className = ['ui-btn', variant ? `ui-btn--${variant}` : '', className].filter(Boolean).join(' ');
  btn.disabled = Boolean(disabled);
  if (autofocus) {
    btn.setAttribute('autofocus', '');
  }
  if (ariaLabel) {
    btn.setAttribute('aria-label', ariaLabel);
  }
  if (title) {
    btn.title = title;
  }

  for (const [k, v] of Object.entries(dataset)) {
    if (v !== undefined && v !== null) {
      btn.dataset[k] = String(v);
    }
  }

  if (iconSvg) {
    const iconSpan = doc.createElement('span');
    iconSpan.className = 'ui-btn-icon';
    iconSpan.setAttribute('aria-hidden', 'true');
    iconSpan.innerHTML = iconSvg;
    btn.appendChild(iconSpan);
  }

  if (label) {
    const labelSpan = doc.createElement('span');
    labelSpan.className = 'ui-btn-label';
    labelSpan.textContent = label;
    btn.appendChild(labelSpan);
  }

  if (typeof onClick === 'function') {
    btn.addEventListener('click', onClick);
  }

  return btn;
}
