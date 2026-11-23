/**
 * Shared accessible search-as-you-type autocomplete dropdown controller.
 * Supports instant local suggestions, debounced remote suggestions, and keyboard navigation.
 */

const ICONS = {
  search: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>`,
  bookmark: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon></svg>`,
  tab: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"></rect><line x1="3" y1="9" x2="21" y2="9"></line></svg>`,
  bang: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="4 17 10 11 4 5"></polyline><line x1="12" y1="19" x2="20" y2="19"></line></svg>`,
  account: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle></svg>`,
  hashtag: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="4" y1="9" x2="20" y2="9"></line><line x1="4" y1="15" x2="20" y2="15"></line><line x1="10" y1="3" x2="8" y2="21"></line><line x1="16" y1="3" x2="14" y2="21"></line></svg>`,
  feed: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 11a9 9 0 0 1 9 9"></path><path d="M4 4a16 16 0 0 1 16 16"></path><circle cx="5" cy="19" r="1"></circle></svg>`,
  server: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="2" width="20" height="8" rx="2" ry="2"></rect><rect x="2" y="14" width="20" height="8" rx="2" ry="2"></rect><line x1="6" y1="6" x2="6.01" y2="6"></line><line x1="6" y1="18" x2="6.01" y2="18"></line></svg>`,
  journal: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"></path><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"></path></svg>`,
};

export function attachSearchSuggestions(
  inputEl,
  {
    anchorEl = null,
    getLocalSuggestions = null,
    fetchRemoteSuggestions = null,
    mergeSuggestions = null,
    onSelect = null,
    debounceMs = 180,
    minChars = 1,
    maxItems = 7,
  } = {}
) {
  if (!inputEl) return { close() {}, destroy() {} };
  const doc = inputEl.ownerDocument || globalThis.document;
  const host = anchorEl || inputEl.parentElement;
  if (!host) return { close() {}, destroy() {} };

  host.classList?.add?.('search-suggest-anchor');
  const dropdown = doc.createElement('div');
  dropdown.className = 'search-suggest-dropdown';
  dropdown.setAttribute('role', 'listbox');
  dropdown.hidden = true;
  host.appendChild(dropdown);

  inputEl.setAttribute('autocomplete', 'off');
  inputEl.setAttribute('aria-autocomplete', 'list');
  inputEl.setAttribute('aria-expanded', 'false');

  let items = [];
  let activeIdx = -1;
  let timer = null;
  let epoch = 0;
  let destroyed = false;

  function close() {
    clearTimeout(timer);
    timer = null;
    items = [];
    activeIdx = -1;
    dropdown.hidden = true;
    dropdown.replaceChildren();
    inputEl.setAttribute('aria-expanded', 'false');
    inputEl.removeAttribute('aria-activedescendant');
  }

  function syncActiveRow() {
    const rows = dropdown.querySelectorAll('.search-suggest-item');
    rows.forEach((row, idx) => {
      const isAct = idx === activeIdx;
      row.classList.toggle('is-active', isAct);
      row.setAttribute('aria-selected', isAct ? 'true' : 'false');
    });
    if (activeIdx >= 0 && rows[activeIdx]?.id) {
      inputEl.setAttribute('aria-activedescendant', rows[activeIdx].id);
    } else {
      inputEl.removeAttribute('aria-activedescendant');
    }
  }

  function selectItem(item) {
    close();
    onSelect?.(item);
  }

  function renderList(nextItems) {
    if (destroyed) return;
    const deduped = [];
    const seen = new Set();
    for (const entry of Array.isArray(nextItems) ? nextItems : []) {
      if (!entry || !entry.label) continue;
      const key = `${entry.kind || 'search'}:${String(entry.value ?? entry.label).toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(entry);
      if (deduped.length >= maxItems) break;
    }
    items = deduped;
    activeIdx = -1;
    dropdown.replaceChildren();

    if (items.length === 0) {
      dropdown.hidden = true;
      inputEl.setAttribute('aria-expanded', 'false');
      return;
    }

    const baseId = inputEl.id || 'search';
    items.forEach((item, idx) => {
      const btn = doc.createElement('button');
      btn.type = 'button';
      btn.id = `${baseId}-suggest-${idx}`;
      btn.className = 'search-suggest-item';
      btn.setAttribute('role', 'option');
      btn.setAttribute('aria-selected', 'false');

      const iconWrap = doc.createElement('span');
      iconWrap.className = `search-suggest-icon is-${item.kind || 'search'}`;
      iconWrap.innerHTML = ICONS[item.icon || item.kind] || ICONS.search;

      const textWrap = doc.createElement('span');
      textWrap.className = 'search-suggest-text';

      const labelEl = doc.createElement('span');
      labelEl.className = 'search-suggest-label';
      labelEl.textContent = item.label;
      textWrap.appendChild(labelEl);

      if (item.sublabel) {
        const subEl = doc.createElement('span');
        subEl.className = 'search-suggest-sub';
        subEl.textContent = item.sublabel;
        textWrap.appendChild(subEl);
      }

      btn.append(iconWrap, textWrap);
      btn.addEventListener('mousedown', (e) => {
        e.preventDefault();
        selectItem(item);
      });
      dropdown.appendChild(btn);
    });

    dropdown.hidden = false;
    inputEl.setAttribute('aria-expanded', 'true');
  }

  function onInput() {
    if (destroyed) return;
    clearTimeout(timer);
    const reqEpoch = ++epoch;
    const q = String(inputEl.value || '').trim();
    if (q.length < minChars) {
      close();
      return;
    }

    const localItems = typeof getLocalSuggestions === 'function' ? (getLocalSuggestions(q) || []) : [];
    renderList(localItems);

    if (typeof fetchRemoteSuggestions === 'function') {
      timer = setTimeout(async () => {
        timer = null;
        try {
          const remoteItems = await fetchRemoteSuggestions(q);
          if (destroyed || reqEpoch !== epoch) return;
          if (String(inputEl.value || '').trim() !== q) return;
          const latestLocal = typeof getLocalSuggestions === 'function' ? (getLocalSuggestions(q) || []) : [];
          const remoteArr = Array.isArray(remoteItems) ? remoteItems : [];
          const merged = typeof mergeSuggestions === 'function'
            ? mergeSuggestions(latestLocal, remoteArr)
            : [...latestLocal, ...remoteArr];
          renderList(merged);
        } catch {
          // Keep local suggestions on network failure
        }
      }, debounceMs);
      timer?.unref?.();
    }
  }

  function onKeyDown(e) {
    if (dropdown.hidden || items.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      activeIdx = (activeIdx + 1) % items.length;
      syncActiveRow();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      activeIdx = activeIdx <= 0 ? items.length - 1 : activeIdx - 1;
      syncActiveRow();
    } else if (e.key === 'Enter' && activeIdx >= 0 && items[activeIdx]) {
      e.preventDefault();
      e.stopPropagation();
      selectItem(items[activeIdx]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  }

  function onBlur() {
    close();
  }

  function onFormSubmit() {
    close();
  }

  const form = inputEl.form || inputEl.closest?.('form');
  inputEl.addEventListener('input', onInput);
  inputEl.addEventListener('keydown', onKeyDown);
  inputEl.addEventListener('blur', onBlur);
  form?.addEventListener('submit', onFormSubmit);

  return {
    close,
    destroy() {
      destroyed = true;
      close();
      inputEl.removeEventListener('input', onInput);
      inputEl.removeEventListener('keydown', onKeyDown);
      inputEl.removeEventListener('blur', onBlur);
      form?.removeEventListener('submit', onFormSubmit);
      dropdown.remove();
    },
  };
}
