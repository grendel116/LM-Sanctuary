/**
 * Surface card wrapper primitive.
 */

export function createCard({
  tag = 'article',
  className = '',
  children = [],
  dataset = {},
} = {}) {
  const doc = globalThis.document;
  const el = doc.createElement(tag);
  el.className = ['ui-card', className].filter(Boolean).join(' ');

  for (const [k, v] of Object.entries(dataset)) {
    if (v !== undefined && v !== null) {
      el.dataset[k] = String(v);
    }
  }

  if (Array.isArray(children)) {
    for (const child of children) {
      if (child) el.appendChild(child);
    }
  } else if (children) {
    el.appendChild(children);
  }

  return el;
}
