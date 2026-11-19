/**
 * Content Warning (CW) disclosure wrapper for Fediverse posts.
 */

let cwCounter = 0;

export function createContentWarning({
  spoilerText,
  contentNode,
  idPrefix = 'cw',
  initiallyExpanded = false,
} = {}) {
  const doc = globalThis.document;
  cwCounter += 1;
  const bodyId = `${idPrefix}-body-${cwCounter}`;

  const wrap = doc.createElement('div');
  wrap.className = 'cw-container';

  const banner = doc.createElement('div');
  banner.className = 'cw-banner';

  const textEl = doc.createElement('span');
  textEl.className = 'cw-label';
  textEl.textContent = String(spoilerText || 'Content warning');

  const toggleBtn = doc.createElement('button');
  toggleBtn.type = 'button';
  toggleBtn.className = 'ui-pill cw-toggle';
  toggleBtn.setAttribute('aria-controls', bodyId);

  const bodyWrap = doc.createElement('div');
  bodyWrap.id = bodyId;
  bodyWrap.className = 'cw-body';
  if (contentNode) {
    bodyWrap.appendChild(contentNode);
  }

  let expanded = Boolean(initiallyExpanded);
  const syncState = () => {
    toggleBtn.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    toggleBtn.textContent = expanded ? 'Hide' : 'Show post';
    bodyWrap.hidden = !expanded;
  };
  syncState();

  toggleBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    expanded = !expanded;
    syncState();
  });

  banner.appendChild(textEl);
  banner.appendChild(toggleBtn);
  wrap.appendChild(banner);
  wrap.appendChild(bodyWrap);
  return wrap;
}
