import { refreshKeePassStatus } from '../../adapters/browserBridge.js';
import { formatApiErrorMessage } from '../../queries/fetch/fetchWrapper.js';
import {
  deleteKeePassXCEntry,
  fetchKeePassXCEntries,
  fetchKeePassXCEntry,
  lockKeePassXC,
  saveKeePassXCEntry,
} from '../../queries/sanctuary.js';
import { lockSocialVaultSession } from '../../state/authStore.js';
import { emitSanctuaryEvent } from '../../state/sanctuary/connection.js';
import { createClassicModalDialog, showConfirm } from './SanctuaryDialog.js';

const KEY_SVG = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--primary-accent)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"></path></svg>`;
const LOCK_SVG = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>`;

function generateKeyBoxPassword(length = 20) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%&*_-+=';
  const bytes = new Uint8Array(length);
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < length; i += 1) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += alphabet[bytes[i] % alphabet.length];
  }
  return out;
}

function matchesSearch(entry, query, groupFilter) {
  if (groupFilter && String(entry.group || '').toLowerCase() !== groupFilter.toLowerCase()) {
    return false;
  }
  const tokens = String(query || '')
    .trim()
    .toLowerCase()
    .split(' ')
    .filter(Boolean);
  if (tokens.length === 0) return true;
  const haystack = [
    entry.title,
    entry.name,
    entry.login,
    entry.url,
    entry.group,
    entry.key_name,
    entry.notes_preview,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return tokens.every((tok) => haystack.includes(tok));
}

function normalizeEntriesResponse(res) {
  if (Array.isArray(res?.entries)) {
    return {
      entries: res.entries,
      groups: Array.isArray(res.groups) && res.groups.length > 0 ? res.groups : ['Browser Logins', 'API Keys'],
    };
  }
  const logins = Array.isArray(res?.logins) ? res.logins : [];
  const apiKeys = Array.isArray(res?.api_keys) ? res.api_keys : [];
  const merged = [
    ...logins.map((l) => ({
      uuid: l.uuid,
      title: l.name || l.login || l.url,
      name: l.name || l.login || l.url,
      login: l.login || '',
      url: l.url || '',
      group: l.group || 'Browser Logins',
      notes_preview: l.notes_preview || '',
      kind: 'login',
      key_name: '',
    })),
    ...apiKeys.map((k) => ({
      uuid: k.uuid,
      title: k.name || k.key_name,
      name: k.name || k.key_name,
      login: k.key_name || '',
      url: '',
      group: 'API Keys',
      notes_preview: '',
      kind: 'api_key',
      key_name: k.key_name || '',
    })),
  ];
  return {
    entries: merged,
    groups: ['Browser Logins', 'API Keys'],
  };
}

/**
 * Dedicated searchable and editable modal for the unlocked .kdbx credential vault.
 */
export function openKeyBoxModal({
  initialQuery = '',
  initialUrl = '',
  startCreating = false,
  onAutofill = null,
  onChanged = null,
} = {}) {
  const doc = globalThis.document;
  let closed = false;
  let loading = true;
  let saving = false;
  let entries = [];
  let groups = ['Browser Logins', 'API Keys'];
  let searchQuery = String(initialQuery || '');
  let groupFilter = '';
  let statusMessage = '';
  let statusIsError = false;
  let editingEntry = startCreating
    ? {
        uuid: '',
        title: '',
        login: '',
        password: '',
        url: String(initialUrl || ''),
        notes: '',
        group: 'Browser Logins',
        kind: 'login',
        key_name: '',
      }
    : null;

  const modal = createClassicModalDialog({
    id: 'keybox-vault-dialog',
    maxWidth: '640px',
    onClose: () => {
      closed = true;
      modal.dialog.remove();
    },
  });

  const heading = doc.createElement('h3');
  heading.id = modal.titleId;
  heading.className = 'classic-modal-title';
  heading.innerHTML = `${KEY_SVG}<span>Key Box (.kdbx)</span>`;

  const subtitle = doc.createElement('p');
  subtitle.className = 'classic-modal-desc';
  subtitle.textContent = 'Search, create, edit, or copy entries stored in your encrypted .kdbx vault.';

  const statusEl = doc.createElement('p');
  statusEl.className = 'classic-modal-status';
  statusEl.hidden = true;

  const bodyHost = doc.createElement('div');
  bodyHost.className = 'classic-modal-scroll-body';

  modal.card.append(heading, subtitle, statusEl, bodyHost);

  function setStatus(msg, isError = false) {
    statusMessage = String(msg || '');
    statusIsError = Boolean(isError);
    statusEl.textContent = statusMessage;
    statusEl.className = `classic-modal-status${statusIsError ? ' is-error' : ''}`;
    statusEl.hidden = !statusMessage;
  }

  async function loadEntries() {
    loading = true;
    render();
    try {
      const res = await fetchKeePassXCEntries();
      if (closed) return;
      const norm = normalizeEntriesResponse(res);
      entries = norm.entries;
      groups = norm.groups;
      subtitle.textContent = `Unlocked (.kdbx) · ${entries.length} ${entries.length === 1 ? 'entry' : 'entries'} across ${groups.length} ${groups.length === 1 ? 'group' : 'groups'}.`;
    } catch (err) {
      if (closed) return;
      setStatus(formatApiErrorMessage(err?.message, 'Could not load vault entries.'), true);
    } finally {
      loading = false;
      if (!closed) render();
    }
  }

  function renderBrowseView() {
    const wrap = doc.createElement('div');
    wrap.className = 'classic-cards-stack';

    const searchWrap = doc.createElement('search');
    const toolbar = doc.createElement('div');
    toolbar.className = 'classic-picker-row';
    toolbar.style.flexWrap = 'wrap';
    toolbar.style.gap = '8px';

    const searchLabel = doc.createElement('label');
    searchLabel.setAttribute('for', 'keybox-search-input');
    searchLabel.className = 'visually-hidden';
    searchLabel.textContent = 'Search vault entries';

    const searchInput = doc.createElement('input');
    searchInput.type = 'search';
    searchInput.id = 'keybox-search-input';
    searchInput.className = 'onboarding-input';
    searchInput.style.flex = '1';
    searchInput.style.minWidth = '180px';
    searchInput.placeholder = 'Search title, username, URL, group, or notes…';
    searchInput.value = searchQuery;
    searchInput.setAttribute('autocorrect', 'off');
    searchInput.setAttribute('autocapitalize', 'none');
    searchInput.setAttribute('spellcheck', 'false');

    const groupSelect = doc.createElement('select');
    groupSelect.id = 'keybox-group-filter';
    groupSelect.className = 'onboarding-input';
    groupSelect.style.width = 'auto';
    groupSelect.style.minWidth = '130px';
    groupSelect.setAttribute('aria-label', 'Filter by group');
    const allOpt = doc.createElement('option');
    allOpt.value = '';
    allOpt.textContent = 'All Groups';
    groupSelect.appendChild(allOpt);
    for (const g of groups) {
      const opt = doc.createElement('option');
      opt.value = g;
      opt.textContent = g;
      if (groupFilter === g) opt.selected = true;
      groupSelect.appendChild(opt);
    }

    const newBtn = doc.createElement('button');
    newBtn.type = 'button';
    newBtn.id = 'keybox-new-entry-btn';
    newBtn.className = 'btn-sleek-pill';
    newBtn.textContent = '+ New Entry';
    newBtn.addEventListener('click', () => {
      setStatus('');
      editingEntry = {
        uuid: '',
        title: '',
        login: '',
        password: '',
        url: String(initialUrl || ''),
        notes: '',
        group: groupFilter || 'Browser Logins',
        kind: 'login',
        key_name: '',
      };
      render();
    });

    const lockBtn = doc.createElement('button');
    lockBtn.type = 'button';
    lockBtn.id = 'keybox-lock-btn';
    lockBtn.className = 'action-icon-btn';
    lockBtn.setAttribute('aria-label', 'Lock Vault');
    lockBtn.title = 'Lock Vault';
    lockBtn.innerHTML = LOCK_SVG;
    lockBtn.addEventListener('click', async () => {
      await lockKeePassXC().catch(() => {});
      await lockSocialVaultSession();
      emitSanctuaryEvent('sanctuary:vault-changed', { unlocked: false });
      await refreshKeePassStatus().catch(() => {});
      await onChanged?.();
      modal.close();
    });

    toolbar.append(searchLabel, searchInput, groupSelect, newBtn, lockBtn);
    searchWrap.appendChild(toolbar);

    const listHost = doc.createElement('div');
    listHost.id = 'keybox-entries-list';
    listHost.className = 'classic-cards-stack';

    const drawRows = () => {
      listHost.replaceChildren();
      if (loading) {
        const empty = doc.createElement('p');
        empty.className = 'classic-card-subtext';
        empty.textContent = 'Loading .kdbx entries…';
        listHost.appendChild(empty);
        return;
      }

      const filtered = entries.filter((item) => matchesSearch(item, searchQuery, groupFilter));
      if (filtered.length === 0) {
        const empty = doc.createElement('div');
        empty.className = 'empty-state';
        empty.textContent = entries.length === 0
          ? 'No entries saved in this vault yet.'
          : 'No entries match your search.';
        listHost.appendChild(empty);
        return;
      }

      for (const item of filtered) {
        const row = doc.createElement('div');
        row.className = 'list-entry-row row-layout';
        row.dataset.entryUuid = item.uuid || '';

        const infoCol = doc.createElement('div');
        infoCol.style.minWidth = '0';
        infoCol.style.flex = '1';

        const topLine = doc.createElement('div');
        topLine.style.display = 'flex';
        topLine.style.alignItems = 'center';
        topLine.style.gap = '6px';
        topLine.style.minWidth = '0';

        const titleEl = doc.createElement('span');
        titleEl.style.fontWeight = '600';
        titleEl.style.overflow = 'hidden';
        titleEl.style.textOverflow = 'ellipsis';
        titleEl.style.whiteSpace = 'nowrap';
        titleEl.textContent = item.title || item.name || item.login || 'Untitled Entry';

        const badge = doc.createElement('span');
        badge.className = 'badge-default';
        badge.textContent = item.group || (item.kind === 'api_key' ? 'API Keys' : 'Browser Logins');

        topLine.append(titleEl, badge);

        const subLine = doc.createElement('div');
        subLine.className = 'classic-card-subtext';
        subLine.style.overflow = 'hidden';
        subLine.style.textOverflow = 'ellipsis';
        subLine.style.whiteSpace = 'nowrap';
        const subParts = [];
        if (item.kind === 'api_key') {
          subParts.push(`API Key: ${item.key_name || item.login}`);
        } else {
          if (item.login) subParts.push(item.login);
          if (item.url) subParts.push(item.url);
        }
        if (item.notes_preview) subParts.push(item.notes_preview);
        subLine.textContent = subParts.join(' · ') || 'No username or URL';

        infoCol.append(topLine, subLine);

        const rowActions = doc.createElement('div');
        rowActions.className = 'classic-card-actions';

        if (typeof onAutofill === 'function' && item.kind !== 'api_key') {
          const fillBtn = doc.createElement('button');
          fillBtn.type = 'button';
          fillBtn.className = 'edit-btn';
          fillBtn.textContent = 'Fill';
          fillBtn.addEventListener('click', async () => {
            try {
              const res = await fetchKeePassXCEntry(item.uuid);
              if (res?.entry) {
                await onAutofill(res.entry);
                modal.close();
              }
            } catch (err) {
              setStatus(formatApiErrorMessage(err?.message, 'Could not read entry.'), true);
            }
          });
          rowActions.appendChild(fillBtn);
        }

        const copyBtn = doc.createElement('button');
        copyBtn.type = 'button';
        copyBtn.className = 'edit-btn';
        copyBtn.textContent = 'Copy';
        copyBtn.addEventListener('click', async () => {
          try {
            const res = await fetchKeePassXCEntry(item.uuid);
            const secret = res?.entry?.password || '';
            if (!secret) {
              setStatus('This entry has no password/secret saved.', true);
              return;
            }
            await globalThis.navigator?.clipboard?.writeText?.(secret);
            setStatus(`Copied secret for ${item.title || item.login || 'entry'}.`);
          } catch (err) {
            setStatus(formatApiErrorMessage(err?.message, 'Failed to copy secret.'), true);
          }
        });

        const editBtn = doc.createElement('button');
        editBtn.type = 'button';
        editBtn.className = 'edit-btn keybox-edit-btn';
        editBtn.textContent = 'Edit';
        editBtn.addEventListener('click', async () => {
          setStatus('');
          try {
            const res = await fetchKeePassXCEntry(item.uuid);
            if (!closed && res?.entry) {
              editingEntry = { ...res.entry };
              render();
            }
          } catch (err) {
            setStatus(formatApiErrorMessage(err?.message, 'Could not load entry details.'), true);
          }
        });

        const delBtn = doc.createElement('button');
        delBtn.type = 'button';
        delBtn.className = 'action-icon-btn';
        delBtn.setAttribute('aria-label', `Delete ${item.title || item.login || 'entry'}`);
        delBtn.textContent = '×';
        delBtn.addEventListener('click', () => {
          showConfirm(
            'Delete Vault Entry',
            `Delete "${item.title || item.login || 'this entry'}" from your .kdbx vault?`,
            async () => {
              try {
                await deleteKeePassXCEntry(item.uuid);
                await refreshKeePassStatus().catch(() => {});
                await onChanged?.();
                setStatus('Deleted entry from .kdbx vault.');
                await loadEntries();
              } catch (err) {
                setStatus(formatApiErrorMessage(err?.message, 'Could not delete entry.'), true);
              }
            }
          );
        });

        rowActions.append(copyBtn, editBtn, delBtn);
        row.append(infoCol, rowActions);
        listHost.appendChild(row);
      }
    };

    searchInput.addEventListener('input', () => {
      searchQuery = searchInput.value;
      drawRows();
    });
    groupSelect.addEventListener('change', () => {
      groupFilter = groupSelect.value;
      drawRows();
    });

    drawRows();
    wrap.append(searchWrap, listHost);
    bodyHost.replaceChildren(wrap);
  }

  function renderEditorView() {
    const draft = { ...editingEntry };
    const isNew = !draft.uuid;

    const wrap = doc.createElement('div');
    wrap.className = 'classic-cards-stack';

    const topBar = doc.createElement('div');
    topBar.className = 'option-header';
    const backBtn = doc.createElement('button');
    backBtn.type = 'button';
    backBtn.className = 'edit-btn';
    backBtn.textContent = '← Back to Entries';
    backBtn.addEventListener('click', () => {
      setStatus('');
      editingEntry = null;
      render();
    });
    const modeTitle = doc.createElement('h4');
    modeTitle.className = 'modal-sub-header';
    modeTitle.textContent = isNew ? 'New Vault Entry' : `Edit: ${draft.title || draft.login || 'Entry'}`;
    topBar.append(modeTitle, backBtn);

    const form = doc.createElement('form');
    form.id = 'keybox-entry-form';
    form.className = 'classic-cards-stack';

    const datalist = doc.createElement('datalist');
    datalist.id = 'keybox-groups-datalist';
    for (const g of groups) {
      const opt = doc.createElement('option');
      opt.value = g;
      datalist.appendChild(opt);
    }

    if (isNew) {
      const kindGroup = doc.createElement('div');
      kindGroup.className = 'input-group';
      const kindLbl = doc.createElement('label');
      kindLbl.setAttribute('for', 'keybox-field-kind');
      kindLbl.textContent = 'Entry Type';
      const kindSel = doc.createElement('select');
      kindSel.id = 'keybox-field-kind';
      kindSel.name = 'kind';
      kindSel.className = 'onboarding-input';
      const optLogin = doc.createElement('option');
      optLogin.value = 'login';
      optLogin.textContent = 'Login / Password';
      const optKey = doc.createElement('option');
      optKey.value = 'api_key';
      optKey.textContent = 'API Key / Secret';
      kindSel.append(optLogin, optKey);
      kindSel.value = draft.kind === 'api_key' ? 'api_key' : 'login';
      kindSel.addEventListener('change', () => {
        editingEntry = {
          ...draft,
          kind: kindSel.value,
          title: titleIn.value,
          group: kindSel.value === 'api_key' ? 'API Keys' : (groupIn.value || 'Browser Logins'),
          login: loginIn.value,
          password: passIn.value,
          url: urlIn ? urlIn.value : draft.url,
          notes: notesIn.value,
        };
        render();
      });
      kindGroup.append(kindLbl, kindSel);
      form.appendChild(kindGroup);
    }

    const row1 = doc.createElement('div');
    row1.className = 'classic-two-col';

    const titleGroup = doc.createElement('div');
    titleGroup.className = 'input-group';
    const titleLbl = doc.createElement('label');
    titleLbl.setAttribute('for', 'keybox-field-title');
    titleLbl.textContent = 'Title';
    const titleIn = doc.createElement('input');
    titleIn.type = 'text';
    titleIn.id = 'keybox-field-title';
    titleIn.name = 'title';
    titleIn.className = 'onboarding-input';
    titleIn.value = draft.title || '';
    titleIn.placeholder = draft.kind === 'api_key' ? 'e.g. OpenAI API Key' : 'e.g. Bluesky';
    titleGroup.append(titleLbl, titleIn);

    const grpGroup = doc.createElement('div');
    grpGroup.className = 'input-group';
    const grpLbl = doc.createElement('label');
    grpLbl.setAttribute('for', 'keybox-field-group');
    grpLbl.textContent = 'Group';
    const groupIn = doc.createElement('input');
    groupIn.type = 'text';
    groupIn.id = 'keybox-field-group';
    groupIn.name = 'group';
    groupIn.className = 'onboarding-input';
    groupIn.setAttribute('list', 'keybox-groups-datalist');
    groupIn.value = draft.group || (draft.kind === 'api_key' ? 'API Keys' : 'Browser Logins');
    grpGroup.append(grpLbl, groupIn);

    row1.append(titleGroup, grpGroup);
    form.append(datalist, row1);

    const loginGroup = doc.createElement('div');
    loginGroup.className = 'input-group';
    const loginLbl = doc.createElement('label');
    loginLbl.setAttribute('for', 'keybox-field-login');
    loginLbl.textContent = draft.kind === 'api_key' ? 'Key Name' : 'Username / Email';
    const loginIn = doc.createElement('input');
    loginIn.type = 'text';
    loginIn.id = 'keybox-field-login';
    loginIn.name = 'login';
    loginIn.className = 'onboarding-input';
    loginIn.value = draft.kind === 'api_key' ? (draft.key_name || draft.login || '') : (draft.login || '');
    loginIn.placeholder = draft.kind === 'api_key' ? 'e.g. greenpt_api_key' : 'Username or email';
    loginIn.setAttribute('autocorrect', 'off');
    loginIn.setAttribute('autocapitalize', 'none');
    loginIn.setAttribute('spellcheck', 'false');
    loginGroup.append(loginLbl, loginIn);
    form.appendChild(loginGroup);

    const passGroup = doc.createElement('div');
    passGroup.className = 'input-group';
    const passLbl = doc.createElement('label');
    passLbl.setAttribute('for', 'keybox-field-password');
    passLbl.textContent = draft.kind === 'api_key' ? 'Secret Value' : 'Password';
    const passRow = doc.createElement('div');
    passRow.className = 'classic-card-actions';
    passRow.style.flexWrap = 'wrap';
    const passIn = doc.createElement('input');
    passIn.type = 'password';
    passIn.id = 'keybox-field-password';
    passIn.name = 'password';
    passIn.className = 'onboarding-input';
    passIn.style.flex = '1';
    passIn.style.minWidth = '160px';
    passIn.value = draft.password || '';
    passIn.autocomplete = 'new-password';

    const toggleVisBtn = doc.createElement('button');
    toggleVisBtn.type = 'button';
    toggleVisBtn.className = 'edit-btn';
    toggleVisBtn.setAttribute('aria-pressed', 'false');
    toggleVisBtn.textContent = 'Show';
    toggleVisBtn.addEventListener('click', () => {
      const nextShow = passIn.type === 'password';
      passIn.type = nextShow ? 'text' : 'password';
      toggleVisBtn.setAttribute('aria-pressed', nextShow ? 'true' : 'false');
      toggleVisBtn.textContent = nextShow ? 'Hide' : 'Show';
    });

    const genBtn = doc.createElement('button');
    genBtn.type = 'button';
    genBtn.className = 'edit-btn';
    genBtn.textContent = 'Generate';
    genBtn.addEventListener('click', () => {
      passIn.type = 'text';
      passIn.value = generateKeyBoxPassword(20);
      toggleVisBtn.setAttribute('aria-pressed', 'true');
      toggleVisBtn.textContent = 'Hide';
    });

    const copyPassBtn = doc.createElement('button');
    copyPassBtn.type = 'button';
    copyPassBtn.className = 'edit-btn';
    copyPassBtn.textContent = 'Copy';
    copyPassBtn.addEventListener('click', async () => {
      if (!passIn.value) return;
      await globalThis.navigator?.clipboard?.writeText?.(passIn.value);
      setStatus('Copied secret to clipboard.');
    });

    passRow.append(passIn, toggleVisBtn, genBtn, copyPassBtn);
    passGroup.append(passLbl, passRow);
    form.appendChild(passGroup);

    let urlIn = null;
    if (draft.kind !== 'api_key') {
      const urlGroup = doc.createElement('div');
      urlGroup.className = 'input-group';
      const urlLbl = doc.createElement('label');
      urlLbl.setAttribute('for', 'keybox-field-url');
      urlLbl.textContent = 'URL (optional)';
      urlIn = doc.createElement('input');
      urlIn.type = 'text';
      urlIn.id = 'keybox-field-url';
      urlIn.name = 'url';
      urlIn.className = 'onboarding-input';
      urlIn.setAttribute('inputmode', 'url');
      urlIn.setAttribute('autocorrect', 'off');
      urlIn.setAttribute('autocapitalize', 'none');
      urlIn.setAttribute('spellcheck', 'false');
      urlIn.placeholder = 'https://example.com/login';
      urlIn.value = draft.url || '';
      urlGroup.append(urlLbl, urlIn);
      form.appendChild(urlGroup);
    }

    const notesGroup = doc.createElement('div');
    notesGroup.className = 'input-group';
    const notesLbl = doc.createElement('label');
    notesLbl.setAttribute('for', 'keybox-field-notes');
    notesLbl.textContent = 'Notes';
    const notesIn = doc.createElement('textarea');
    notesIn.id = 'keybox-field-notes';
    notesIn.name = 'notes';
    notesIn.className = 'edit-textarea';
    notesIn.rows = 3;
    notesIn.value = draft.notes || '';
    notesGroup.append(notesLbl, notesIn);
    form.appendChild(notesGroup);

    const actionsRow = doc.createElement('div');
    actionsRow.className = 'classic-card-actions';
    actionsRow.style.justifyContent = 'flex-end';

    const cancelBtn = doc.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'edit-btn edit-cancel-btn';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.disabled = saving;
    cancelBtn.addEventListener('click', () => {
      setStatus('');
      editingEntry = null;
      render();
    });

    const saveBtn = doc.createElement('button');
    saveBtn.type = 'submit';
    saveBtn.className = 'btn-sleek-pill';
    saveBtn.textContent = saving ? 'Saving…' : (isNew ? 'Save Entry' : 'Save Changes');
    saveBtn.disabled = saving;

    actionsRow.append(cancelBtn, saveBtn);
    form.appendChild(actionsRow);

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (saving) return;
      saving = true;
      setStatus('');
      saveBtn.disabled = true;
      saveBtn.textContent = 'Saving…';
      try {
        await saveKeePassXCEntry({
          uuid: draft.uuid || '',
          kind: draft.kind === 'api_key' ? 'api_key' : 'login',
          title: titleIn.value.trim(),
          group: groupIn.value.trim(),
          login: loginIn.value.trim(),
          key_name: draft.kind === 'api_key' ? loginIn.value.trim() : '',
          password: passIn.value,
          url: urlIn ? urlIn.value.trim() : '',
          notes: notesIn.value,
        });
        editingEntry = null;
        await refreshKeePassStatus().catch(() => {});
        await onChanged?.();
        setStatus('Saved entry to .kdbx vault.');
        await loadEntries();
      } catch (err) {
        setStatus(formatApiErrorMessage(err?.message, 'Failed to save entry.'), true);
      } finally {
        saving = false;
        if (!closed && editingEntry) {
          saveBtn.disabled = false;
          saveBtn.textContent = isNew ? 'Save Entry' : 'Save Changes';
        }
      }
    });

    wrap.append(topBar, form);
    bodyHost.replaceChildren(wrap);
  }

  function render() {
    if (closed) return;
    if (editingEntry) {
      renderEditorView();
    } else {
      renderBrowseView();
    }
  }

  modal.open();
  void loadEntries();
  return modal;
}
