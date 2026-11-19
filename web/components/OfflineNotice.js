/**
 * Status banner for Sanctuary offline/dormant or queued-turn feedback.
 */

export function createOfflineNotice({
  message,
  variant = 'offline',
  actionLabel = '',
  onAction,
} = {}) {
  const doc = globalThis.document;
  const banner = doc.createElement('div');
  banner.className = `offline-notice offline-notice--${variant}`;
  banner.setAttribute('role', 'status');
  banner.setAttribute('aria-live', 'polite');

  const dot = doc.createElement('span');
  dot.className = 'offline-notice-dot';
  dot.setAttribute('aria-hidden', 'true');

  const text = doc.createElement('span');
  text.className = 'offline-notice-text';
  text.textContent = String(message || 'Offline mode');

  banner.appendChild(dot);
  banner.appendChild(text);

  if (actionLabel && typeof onAction === 'function') {
    const btn = doc.createElement('button');
    btn.type = 'button';
    btn.className = 'ui-pill offline-notice-action';
    btn.textContent = actionLabel;
    btn.addEventListener('click', onAction);
    banner.appendChild(btn);
  }

  return banner;
}
