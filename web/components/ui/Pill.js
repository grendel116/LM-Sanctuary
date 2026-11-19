/**
 * Filter / toggle pill button exposing aria-pressed state.
 */

export function createPill({
  label,
  active = false,
  count = null,
  className = '',
  dataset = {},
  onClick,
} = {}) {
  const doc = globalThis.document;
  const btn = doc.createElement('button');
  btn.type = 'button';
  btn.className = ['ui-pill', active ? 'is-active' : '', className].filter(Boolean).join(' ');
  btn.setAttribute('aria-pressed', active ? 'true' : 'false');

  for (const [k, v] of Object.entries(dataset)) {
    if (v !== undefined && v !== null) {
      btn.dataset[k] = String(v);
    }
  }

  const labelEl = doc.createElement('span');
  labelEl.textContent = String(label || '');
  btn.appendChild(labelEl);

  if (count !== null && count !== undefined) {
    const countEl = doc.createElement('span');
    countEl.className = 'ui-pill-count';
    countEl.textContent = String(count);
    btn.appendChild(countEl);
  }

  if (typeof onClick === 'function') {
    btn.addEventListener('click', onClick);
  }

  return btn;
}
