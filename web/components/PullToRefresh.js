/**
 * Screen header with manual refresh button and vertical touch overscroll trigger.
 */

const REFRESH_SVG = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="23 4 23 10 17 10"></polyline><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path></svg>`;

export function createRefreshHeader({
  title,
  subtitle = '',
  loading = false,
  onRefresh,
  trailingNodes = [],
} = {}) {
  const doc = globalThis.document;
  const header = doc.createElement('header');
  header.className = 'screen-header';

  const titleGroup = doc.createElement('div');
  titleGroup.className = 'screen-header-titles';

  const h1 = doc.createElement('h1');
  h1.className = 'screen-title';
  h1.textContent = String(title || '');
  titleGroup.appendChild(h1);

  if (subtitle) {
    const sub = doc.createElement('p');
    sub.className = 'screen-subtitle';
    sub.textContent = subtitle;
    titleGroup.appendChild(sub);
  }

  const actions = doc.createElement('div');
  actions.className = 'screen-header-actions';

  for (const node of trailingNodes) {
    if (node) actions.appendChild(node);
  }

  if (typeof onRefresh === 'function') {
    const refreshBtn = doc.createElement('button');
    refreshBtn.type = 'button';
    refreshBtn.className = `ui-icon-btn refresh-btn${loading ? ' is-spinning' : ''}`;
    refreshBtn.setAttribute('aria-label', 'Refresh');
    refreshBtn.title = 'Refresh';
    refreshBtn.innerHTML = REFRESH_SVG;
    refreshBtn.addEventListener('click', () => onRefresh());
    actions.appendChild(refreshBtn);
  }

  header.appendChild(titleGroup);
  header.appendChild(actions);
  return header;
}

/**
 * Attach a pull-to-refresh gesture listener scoped strictly to top-of-scroll pulls.
 */
export function attachPullToRefresh(scrollEl, onRefresh) {
  if (!scrollEl || typeof onRefresh !== 'function') return () => {};
  let startY = null;
  let startX = null;

  const onTouchStart = (e) => {
    if (scrollEl.scrollTop <= 0 && e.touches?.length === 1) {
      startY = e.touches[0].clientY;
      startX = e.touches[0].clientX;
    } else {
      startY = null;
      startX = null;
    }
  };

  const onTouchEnd = (e) => {
    if (startY === null || !e.changedTouches?.length) return;
    const touch = e.changedTouches[0];
    const deltaY = touch.clientY - startY;
    const deltaX = Math.abs((touch.clientX || 0) - (startX || 0));
    startY = null;
    startX = null;
    if (deltaY > 72 && deltaY > deltaX * 1.5 && scrollEl.scrollTop <= 0) {
      void onRefresh();
    }
  };

  scrollEl.addEventListener('touchstart', onTouchStart, { passive: true });
  scrollEl.addEventListener('touchend', onTouchEnd, { passive: true });
  return () => {
    scrollEl.removeEventListener('touchstart', onTouchStart);
    scrollEl.removeEventListener('touchend', onTouchEnd);
  };
}
