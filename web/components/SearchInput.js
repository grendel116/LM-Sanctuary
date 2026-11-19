/**
 * Accessible search bar form with debounced change notifications and submit trigger.
 */

const SEARCH_SVG = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>`;

export function createSearchInput({
  id = 'global-search-input',
  placeholder = 'Search Fediverse handles, #tags, URLs, or Sanctuary notes...',
  initialValue = '',
  debounceMs = 280,
  onSearch,
} = {}) {
  const doc = globalThis.document;
  const formEl = doc.createElement('form');
  formEl.className = 'search-bar-form';
  formEl.setAttribute('role', 'search');

  const label = doc.createElement('label');
  label.setAttribute('for', id);
  label.className = 'visually-hidden';
  label.textContent = 'Search';

  const inputWrap = doc.createElement('div');
  inputWrap.className = 'search-input-wrap';

  const iconSpan = doc.createElement('span');
  iconSpan.className = 'search-input-icon';
  iconSpan.setAttribute('aria-hidden', 'true');
  iconSpan.innerHTML = SEARCH_SVG;

  const inputEl = doc.createElement('input');
  inputEl.type = 'search';
  inputEl.id = id;
  inputEl.className = 'search-input-field';
  inputEl.value = String(initialValue || '');
  inputEl.placeholder = placeholder;
  inputEl.setAttribute('autocomplete', 'off');

  const submitBtn = doc.createElement('button');
  submitBtn.type = 'submit';
  submitBtn.className = 'ui-btn ui-btn--primary search-submit-btn';
  submitBtn.textContent = 'Search';

  let timer = null;
  inputEl.addEventListener('input', () => {
    if (timer) clearTimeout(timer);
    if (debounceMs > 0) {
      timer = setTimeout(() => {
        timer = null;
        onSearch?.(inputEl.value.trim(), false);
      }, debounceMs);
      timer?.unref?.();
    }
  });

  formEl.addEventListener('submit', (e) => {
    e.preventDefault();
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    onSearch?.(inputEl.value.trim(), true);
  });

  inputWrap.appendChild(iconSpan);
  inputWrap.appendChild(inputEl);
  formEl.appendChild(label);
  formEl.appendChild(inputWrap);
  formEl.appendChild(submitBtn);

  function setValue(val) {
    inputEl.value = String(val || '');
  }

  return { formEl, inputEl, setValue };
}
