export { createButton } from './Button.js';
export { createPill } from './Pill.js';
export { createCard } from './Card.js';
export { createModalShell } from './ModalShell.js';
export { createSwipeSheet } from './SwipeSheet.js';

/**
 * Accessible indeterminate loading state built on a semantic <progress> element.
 */
export function createLoadingState(label = 'Loading…', { compact = false } = {}) {
  const doc = globalThis.document;
  const wrap = doc.createElement('div');
  wrap.className = `loading-state-card${compact ? ' is-compact' : ''}`;
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
