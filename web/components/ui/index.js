export { createButton } from './Button.js';
export { createPill } from './Pill.js';
export { createCard } from './Card.js';
export { createModalShell } from './ModalShell.js';
export { createSwipeSheet } from './SwipeSheet.js';

/**
 * Accessible indeterminate loading state built on a semantic <progress> element.
 */
export function createLoadingState(
  label = 'Loading…',
  { doc = globalThis.document, compact = false, size = 'default', inline = false } = {}
) {
  const isCompact = Boolean(compact || size === 'compact');
  const isInline = Boolean(inline || size === 'inline');
  const wrap = doc.createElement('div');
  wrap.className = `loading-state-card${isCompact ? ' is-compact' : ''}${isInline ? ' is-inline' : ''}`;
  wrap.setAttribute('role', 'status');
  wrap.setAttribute('aria-live', 'polite');

  const spinner = doc.createElement('progress');
  spinner.className = 'loading-spinner';
  spinner.setAttribute('aria-label', String(label || 'Loading'));

  const textEl = doc.createElement('span');
  textEl.className = 'loading-state-label';
  textEl.textContent = String(label || 'Loading…');

  wrap.append(spinner, textEl);
  return wrap;
}

/**
 * Update the label and accessible progress description on an existing loading state element.
 */
export function updateLoadingStateLabel(el, label = 'Loading…') {
  if (!el) return;
  const text = String(label || 'Loading…');
  const labelEl = el.querySelector('.loading-state-label');
  if (labelEl) labelEl.textContent = text;
  const spinner = el.querySelector('progress.loading-spinner');
  if (spinner) spinner.setAttribute('aria-label', text);
}
