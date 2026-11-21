import {
  deleteDatabankDoc,
  deleteLorebookFile,
  deleteProgramJournalEntry,
  fetchCardLorebookEntries,
  fetchDatabankFiles,
  fetchLorebookEntries,
  fetchLorebooks,
  fetchProgramJournals,
  importLorebookFile,
  ingestDatabankText,
  purgeDatabank,
  saveCardLorebookEntries,
  saveEpicChronicle,
  saveLorebookEntries,
  saveRecentChapter,
  scrapeDatabankUrl,
  selectProgram,
  uploadDatabankFile,
} from '../../queries/sanctuary.js';
import { connectionStore } from '../../state/sanctuary/connection.js';
import { createLoadingState, updateLoadingStateLabel } from '../ui/index.js';
import {
  createClassicModalDialog,
  downloadNodeFile,
  showAlert,
  showConfirm,
  showTextareaPrompt,
} from './SanctuaryDialog.js';

const KB_SVG = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--primary-accent)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="12 2 2 7 12 12 22 7 12 2"></polygon><polyline points="2 17 12 22 22 17"></polyline><polyline points="2 12 12 17 22 12"></polyline></svg>`;
const EDIT_SVG = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"></path><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path></svg>`;
const EXPORT_SVG = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"></path></svg>`;
const TRASH_SVG = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>`;

const DESCRIPTORS = {
  upload: "Upload files (TXT, MD, HTML, PDF) or scrape web page URLs to ingest them into the program's vectorized memory database.",
  memories: 'Manage keyword-triggered log journals and long-term conversation compactions.',
  lorebooks: 'Import and manage interactive lorebooks and World Info files (.json) for dynamic context insertion.',
};

function formatBytes(bytes = 0) {
  const n = Number(bytes || 0);
  if (n <= 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB'];
  const i = Math.min(sizes.length - 1, Math.floor(Math.log(n) / Math.log(k)));
  return `${parseFloat((n / (k ** i)).toFixed(1))} ${sizes[i]}`;
}

function replacePlaceholders(text, userName, programName) {
  return String(text || '')
    .replace(/\{\{user\}\}/gi, userName || 'User')
    .replace(/\{\{char\}\}/gi, programName || 'Program');
}

/**
 * Classic Knowledge Base modal: Data Bank | Journals | Lorebooks (with visual World Info Entry Editor).
 */
export function openKnowledgeModal({
  programId,
  programName = 'Program',
  sessionId = 'default',
  userName = 'User',
  initialTab = 'upload',
} = {}) {
  const doc = globalThis.document;
  let activeTab = DESCRIPTORS[initialTab] ? initialTab : 'upload';
  let closed = false;
  let tabEpoch = 0;

  const modal = createClassicModalDialog({
    id: 'databank-dialog',
    maxWidth: '600px',
    onClose: () => {
      closed = true;
      modal.dialog.remove();
    },
  });

  const heading = doc.createElement('h3');
  heading.id = modal.titleId;
  heading.className = 'classic-modal-title';
  heading.innerHTML = `${KB_SVG}<span>Knowledge Base</span>`;

  const descriptorEl = doc.createElement('p');
  descriptorEl.id = 'databank-descriptor';
  descriptorEl.className = 'classic-modal-desc';
  descriptorEl.textContent = DESCRIPTORS[activeTab];

  const tabBar = doc.createElement('div');
  tabBar.className = 'classic-modal-tabs';
  const uploadBtn = doc.createElement('button');
  uploadBtn.type = 'button';
  uploadBtn.className = 'modal-tab-btn';
  uploadBtn.textContent = 'Data Bank';
  const memBtn = doc.createElement('button');
  memBtn.type = 'button';
  memBtn.className = 'modal-tab-btn';
  memBtn.textContent = 'Journals';
  const loreBtn = doc.createElement('button');
  loreBtn.type = 'button';
  loreBtn.className = 'modal-tab-btn';
  loreBtn.textContent = 'Lorebooks';
  tabBar.append(uploadBtn, memBtn, loreBtn);

  const loaderEl = createLoadingState('Vectorizing and indexing content…', { doc, inline: true });
  loaderEl.hidden = true;

  const bodyHost = doc.createElement('div');
  bodyHost.className = 'classic-modal-scroll-body';

  modal.card.append(heading, descriptorEl, tabBar, loaderEl, bodyHost);

  const ensureActiveProgram = async () => {
    if (programId && connectionStore.get().activeProgram !== programId) {
      await selectProgram(programId).catch(() => {});
      connectionStore.set({ activeProgram: programId });
    }
  };

  function setLoading(loading, msg = 'Vectorizing and indexing content…') {
    loaderEl.hidden = !loading;
    updateLoadingStateLabel(loaderEl, msg);
  }

  async function renderDataBankTab(epoch = tabEpoch) {
    const filesData = await fetchDatabankFiles().catch((e) => ({ error: e.message }));
    if (closed || activeTab !== 'upload' || epoch !== tabEpoch) return;

    const wrap = doc.createElement('div');
    wrap.className = 'classic-cards-stack';

    const fileInput = doc.createElement('input');
    fileInput.type = 'file';
    fileInput.id = 'databank-file-input';
    fileInput.accept = '.txt,.md,.html,.htm,.pdf';
    fileInput.className = 'visually-hidden';
    fileInput.hidden = true;
    fileInput.addEventListener('change', async () => {
      const f = fileInput.files?.[0];
      if (!f) return;
      setLoading(true, `Indexing file '${f.name}'...`);
      try {
        await uploadDatabankFile(f);
      } catch (err) {
        showAlert('Upload Failed', err?.message || 'Could not index document.');
      } finally {
        fileInput.value = '';
        setLoading(false);
        void loadTab();
      }
    });

    const topBtns = doc.createElement('div');
    topBtns.className = 'classic-modal-tabs';

    const selFileBtn = doc.createElement('button');
    selFileBtn.type = 'button';
    selFileBtn.className = 'dashed-action-btn';
    selFileBtn.style.flex = '1';
    selFileBtn.style.textAlign = 'center';
    selFileBtn.textContent = '+ Select File (.txt, .pdf, .md)';
    selFileBtn.addEventListener('click', () => fileInput.click());

    const pasteBtn = doc.createElement('button');
    pasteBtn.type = 'button';
    pasteBtn.className = 'dashed-action-btn';
    pasteBtn.style.flex = '1';
    pasteBtn.textContent = '+ Paste Text';
    pasteBtn.addEventListener('click', () => {
      showTextareaPrompt(
        'Ingest Text Document',
        'Paste or type the text to vectorize and index into the Data Bank:',
        '',
        async (text) => {
          if (!String(text || '').trim()) return;
          setLoading(true, 'Vectorizing and indexing text content...');
          try {
            await ingestDatabankText(text.trim(), '');
          } catch (err) {
            showAlert('Ingest Failed', err?.message || 'Failed to ingest text.');
          } finally {
            setLoading(false);
            void loadTab();
          }
        }
      );
    });

    topBtns.append(selFileBtn, pasteBtn);

    const divider = doc.createElement('div');
    divider.className = 'or-divider';
    divider.innerHTML = '<div class="or-divider-line"></div><span class="or-divider-text">or</span><div class="or-divider-line"></div>';

    const urlCard = doc.createElement('div');
    urlCard.className = 'form-card-container';
    const urlRow = doc.createElement('div');
    urlRow.className = 'classic-picker-row';
    const urlIn = doc.createElement('input');
    urlIn.type = 'url';
    urlIn.id = 'databank-url-input';
    urlIn.className = 'onboarding-input';
    urlIn.style.flex = '1';
    urlIn.placeholder = 'https://example.com/article';
    const scrapeBtn = doc.createElement('button');
    scrapeBtn.type = 'button';
    scrapeBtn.className = 'edit-btn edit-save-btn';
    scrapeBtn.textContent = 'Scrape URL';
    scrapeBtn.addEventListener('click', async () => {
      let url = urlIn.value.trim();
      if (!url) return;
      if (url.includes(' ') || url.includes('\n')) {
        showConfirm(
          'Ingest as Text Document?',
          'The input contains spaces or lines rather than a URL. Index it directly as a text document?',
          async () => {
            urlIn.value = '';
            setLoading(true, 'Vectorizing and indexing text content...');
            try {
              await ingestDatabankText(url, '');
            } catch (err) {
              showAlert('Ingest Failed', err?.message || 'Failed to ingest text.');
            } finally {
              setLoading(false);
              void loadTab();
            }
          }
        );
        return;
      }
      if (!url.startsWith('http://') && !url.startsWith('https://')) {
        if (/^[a-zA-Z0-9][-a-zA-Z0-9.]*\.[a-zA-Z]{2,}/.test(url)) {
          url = `https://${url}`;
        } else {
          showAlert('Invalid URL', "Enter a valid web URL starting with https://, or use '+ Paste Text'.");
          return;
        }
      }
      setLoading(true, `Scraping and indexing '${url}'...`);
      try {
        await scrapeDatabankUrl(url);
        urlIn.value = '';
      } catch (err) {
        showAlert('Scraping Failed', err?.message || 'Could not scrape URL.');
      } finally {
        setLoading(false);
        void loadTab();
      }
    });
    urlRow.append(urlIn, scrapeBtn);
    urlCard.appendChild(urlRow);

    const docsSection = doc.createElement('div');
    docsSection.className = 'classic-section-divider';
    const docsHead = doc.createElement('div');
    docsHead.className = 'modal-section-header';
    const docsLbl = doc.createElement('span');
    docsLbl.textContent = 'Ingested Documents';
    const purgeBtn = doc.createElement('button');
    purgeBtn.type = 'button';
    purgeBtn.className = 'edit-btn edit-cancel-btn';
    purgeBtn.style.padding = '2px 8px';
    purgeBtn.style.fontSize = '0.75rem';
    purgeBtn.textContent = 'Purge All';
    purgeBtn.addEventListener('click', () => {
      showConfirm(
        'Purge Knowledge Base',
        "Delete all indexed files and empty the program's vectorized memory?",
        async () => {
          setLoading(true, 'Purging knowledge index...');
          try {
            const res = await purgeDatabank();
            if (res?.error) throw new Error(res.error);
          } catch (err) {
            showAlert('Purge Failed', err?.message || 'Could not purge Knowledge Base.');
          } finally {
            setLoading(false);
            void loadTab();
          }
        }
      );
    });
    docsHead.append(docsLbl, purgeBtn);

    const listBox = doc.createElement('div');
    listBox.className = 'list-container';
    const files = filesData?.files || [];
    if (filesData?.error) {
      const errDiv = doc.createElement('div');
      errDiv.className = 'empty-state';
      errDiv.textContent = filesData.error;
      listBox.appendChild(errDiv);
    } else if (files.length === 0) {
      const empty = doc.createElement('div');
      empty.className = 'empty-state';
      empty.textContent = 'Knowledge Base is empty.';
      listBox.appendChild(empty);
    } else {
      for (const f of files) {
        const row = doc.createElement('div');
        row.className = 'file-list-entry';
        const info = doc.createElement('div');
        const titleEl = doc.createElement('div');
        titleEl.style.fontWeight = '500';
        titleEl.textContent = f.name || f.title || f.id;
        const meta = doc.createElement('div');
        meta.className = 'classic-card-subtext';
        const added = f.timestamp ? new Date(f.timestamp * 1000).toLocaleDateString() : '';
        meta.textContent = [`Size: ${formatBytes(f.size)}`, `Chunks: ${f.chunk_count ?? 0}`, added ? `Added: ${added}` : '']
          .filter(Boolean)
          .join(' · ');
        info.append(titleEl, meta);

        const delB = doc.createElement('button');
        delB.type = 'button';
        delB.className = 'action-icon-btn';
        delB.title = 'Delete from memory';
        delB.innerHTML = TRASH_SVG;
        delB.addEventListener('click', async () => {
          delB.disabled = true;
          try {
            const res = await deleteDatabankDoc(f.id);
            if (res?.error) throw new Error(res.error);
            void loadTab();
          } catch (err) {
            delB.disabled = false;
            showAlert('Delete Failed', err?.message || 'Unable to delete document.');
          }
        });
        row.append(info, delB);
        listBox.appendChild(row);
      }
    }

    docsSection.append(docsHead, listBox);
    wrap.append(fileInput, topBtns, divider, urlCard, docsSection);
    bodyHost.replaceChildren(wrap);
  }

  async function renderJournalsTab(epoch = tabEpoch) {
    const jData = await fetchProgramJournals(programId, sessionId).catch(() => ({
      journals: [],
      recent_chapters: [],
      epic_chronicle: '',
    }));
    if (closed || activeTab !== 'memories' || epoch !== tabEpoch) return;

    let rawEpic = (jData.epic_chronicle || '').trim();
    const recentChapters = [...(jData.recent_chapters || [])];
    const journals = jData.journals || [];

    const wrap = doc.createElement('div');
    wrap.className = 'classic-cards-stack';

    // 1. Full Summary
    const epicHeader = doc.createElement('div');
    epicHeader.className = 'modal-section-header';
    const epicLbl = doc.createElement('span');
    epicLbl.textContent = 'Full Summary';
    const editEpicBtn = doc.createElement('button');
    editEpicBtn.type = 'button';
    editEpicBtn.className = 'action-icon-btn';
    editEpicBtn.title = 'Edit Full Summary';
    editEpicBtn.innerHTML = EDIT_SVG;
    epicHeader.append(epicLbl, editEpicBtn);

    const epicBox = doc.createElement('div');
    const drawEpic = (editing = false) => {
      epicBox.replaceChildren();
      editEpicBtn.hidden = editing;
      if (editing) {
        const card = doc.createElement('div');
        card.className = 'list-entry-row';
        card.style.borderLeft = '3px solid var(--primary-accent)';
        const ta = doc.createElement('textarea');
        ta.className = 'edit-textarea';
        ta.rows = 5;
        ta.value = rawEpic;
        ta.placeholder = 'Enter full conversation summary...';
        const grp = doc.createElement('div');
        grp.className = 'edit-btn-group';
        const cBtn = doc.createElement('button');
        cBtn.type = 'button';
        cBtn.className = 'edit-btn edit-cancel-btn';
        cBtn.textContent = 'Cancel';
        cBtn.addEventListener('click', () => drawEpic(false));
        const sBtn = doc.createElement('button');
        sBtn.type = 'button';
        sBtn.className = 'edit-btn edit-save-btn';
        sBtn.textContent = 'Save';
        const save = async () => {
          sBtn.disabled = true;
          cBtn.disabled = true;
          sBtn.textContent = 'Saving...';
          try {
            const nextText = ta.value.trim();
            const res = await saveEpicChronicle(nextText, sessionId);
            if (res?.error) throw new Error(res.error);
            rawEpic = nextText;
            drawEpic(false);
          } catch (err) {
            showAlert('Save Failed', err?.message || 'Could not save full summary.');
            sBtn.disabled = false;
            cBtn.disabled = false;
            sBtn.textContent = 'Save';
          }
        };
        sBtn.addEventListener('click', () => void save());
        ta.addEventListener('keydown', (e) => {
          if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
            e.preventDefault();
            void save();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            drawEpic(false);
          }
        });
        grp.append(cBtn, sBtn);
        card.append(ta, grp);
        epicBox.appendChild(card);
        ta.focus?.();
      } else if (rawEpic) {
        const card = doc.createElement('div');
        card.className = 'list-entry-row';
        card.style.borderLeft = '3px solid var(--primary-accent)';
        const contentEl = doc.createElement('div');
        contentEl.className = 'list-entry-content';
        contentEl.style.whiteSpace = 'pre-wrap';
        contentEl.textContent = replacePlaceholders(rawEpic, userName, programName);
        card.appendChild(contentEl);
        epicBox.appendChild(card);
      } else {
        const empty = doc.createElement('div');
        empty.className = 'empty-state';
        empty.textContent = 'No full conversation summary compiled yet.';
        epicBox.appendChild(empty);
      }
    };
    editEpicBtn.addEventListener('click', () => drawEpic(true));
    drawEpic(false);

    // 2. Recent Summary Chapters
    const chapHeader = doc.createElement('div');
    chapHeader.className = 'modal-section-header';
    chapHeader.textContent = 'Recent Summary';
    const chapHost = doc.createElement('div');
    chapHost.className = 'classic-cards-stack';

    const drawChapters = (editingIdx = null) => {
      chapHost.replaceChildren();
      if (recentChapters.length === 0) {
        const empty = doc.createElement('div');
        empty.className = 'empty-state';
        empty.textContent = 'No recent summaries compiled yet (distilled every 12 conversation turns).';
        chapHost.appendChild(empty);
        return;
      }
      recentChapters.forEach((chText, idx) => {
        const row = doc.createElement('div');
        row.className = 'list-entry-row';
        if (editingIdx === idx) {
          const ta = doc.createElement('textarea');
          ta.className = 'edit-textarea';
          ta.rows = 4;
          ta.value = chText || '';
          const grp = doc.createElement('div');
          grp.className = 'edit-btn-group';
          const cBtn = doc.createElement('button');
          cBtn.type = 'button';
          cBtn.className = 'edit-btn edit-cancel-btn';
          cBtn.textContent = 'Cancel';
          cBtn.addEventListener('click', () => drawChapters(null));
          const sBtn = doc.createElement('button');
          sBtn.type = 'button';
          sBtn.className = 'edit-btn edit-save-btn';
          sBtn.textContent = 'Save';
          const saveChap = async () => {
            sBtn.disabled = true;
            cBtn.disabled = true;
            sBtn.textContent = 'Saving...';
            try {
              const nextContent = ta.value.trim();
              const res = await saveRecentChapter(idx, nextContent, sessionId);
              if (res?.error) throw new Error(res.error);
              recentChapters[idx] = nextContent;
              drawChapters(null);
            } catch (err) {
              showAlert('Save Failed', err?.message || 'Could not save summary.');
              sBtn.disabled = false;
              cBtn.disabled = false;
              sBtn.textContent = 'Save';
            }
          };
          sBtn.addEventListener('click', () => void saveChap());
          ta.addEventListener('keydown', (e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
              e.preventDefault();
              void saveChap();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              drawChapters(null);
            }
          });
          grp.append(cBtn, sBtn);
          row.append(ta, grp);
          setTimeout(() => ta.focus?.(), 0);
        } else {
          const h = doc.createElement('div');
          h.className = 'list-entry-header';
          const tag = doc.createElement('span');
          tag.style.color = 'var(--primary-accent)';
          tag.style.fontWeight = '600';
          tag.textContent = `Summary ${idx + 1}`;
          const eBtn = doc.createElement('button');
          eBtn.type = 'button';
          eBtn.className = 'action-icon-btn';
          eBtn.title = `Edit Summary ${idx + 1}`;
          eBtn.innerHTML = EDIT_SVG;
          eBtn.addEventListener('click', () => drawChapters(idx));
          h.append(tag, eBtn);
          const bodyEl = doc.createElement('div');
          bodyEl.className = 'list-entry-content';
          bodyEl.style.whiteSpace = 'pre-wrap';
          bodyEl.textContent = replacePlaceholders(chText, userName, programName);
          row.append(h, bodyEl);
        }
        chapHost.appendChild(row);
      });
    };
    drawChapters(null);

    // 3. Log Journals
    const logHeader = doc.createElement('div');
    logHeader.className = 'modal-section-header';
    logHeader.textContent = 'Log Journals';
    const logList = doc.createElement('div');
    logList.className = 'classic-cards-stack';

    if (journals.length === 0) {
      const empty = doc.createElement('div');
      empty.className = 'empty-state';
      empty.textContent = 'No log journals saved for this program yet.';
      logList.appendChild(empty);
    } else {
      for (const entry of journals) {
        const row = doc.createElement('div');
        row.className = 'list-entry-row';
        const h = doc.createElement('div');
        h.className = 'list-entry-header';
        const kps = doc.createElement('span');
        kps.style.color = 'var(--primary-accent)';
        kps.style.fontWeight = '600';
        kps.textContent = Array.isArray(entry.keyphrases) && entry.keyphrases.length
          ? entry.keyphrases.join(', ')
          : (entry.topic || 'no triggers');
        const delB = doc.createElement('button');
        delB.type = 'button';
        delB.className = 'action-icon-btn';
        delB.title = 'Delete Journal Entry';
        delB.innerHTML = TRASH_SVG;
        delB.addEventListener('click', () => {
          showConfirm(
            'Delete Memory Entry',
            'Permanently delete this memory entry?',
            async () => {
              try {
                const res = await deleteProgramJournalEntry(entry.id, programId);
                if (res?.error) throw new Error(res.error);
                await loadTab();
              } catch (err) {
                showAlert('Delete Failed', err?.message || 'Could not delete memory entry.');
              }
            }
          );
        });
        h.append(kps, delB);

        const bodyEl = doc.createElement('div');
        bodyEl.className = 'list-entry-content';
        bodyEl.textContent = replacePlaceholders(entry.content || entry.summary || '', userName, programName);
        row.append(h, bodyEl);
        logList.appendChild(row);
      }
    }

    const epicSection = doc.createElement('div');
    epicSection.className = 'classic-modal-section';
    epicSection.append(epicHeader, epicBox);

    const chapSection = doc.createElement('div');
    chapSection.className = 'classic-section-divider';
    chapSection.append(chapHeader, chapHost);

    const logSection = doc.createElement('div');
    logSection.className = 'classic-section-divider';
    logSection.append(logHeader, logList);

    wrap.append(epicSection, chapSection, logSection);
    bodyHost.replaceChildren(wrap);
  }

  function renderEntriesEditor(panel, entries, isCardBook, filename, { onSavedEntries, onCountChanged } = {}) {
    const working = (entries || []).map((e) => ({
      keys: (e.keys || e.key || []).join(', '),
      secondary_keys: (e.secondary_keys || e.keysecondary || []).join(', '),
      content: e.content || '',
      constant: Boolean(e.constant),
      enabled: e.enabled !== false,
      name: e.name || e.comment || '',
      insertion_order: e.insertion_order ?? e.order ?? 100,
      position: e.position ?? 'before_char',
      _raw: e,
    }));

    const redraw = (focusNew = false) => {
      panel.replaceChildren();
      const list = doc.createElement('div');
      list.className = 'classic-lore-entries-list';

      if (working.length === 0) {
        const empty = doc.createElement('p');
        empty.className = 'classic-card-subtext';
        empty.style.padding = '10px 14px';
        empty.textContent = 'No entries.';
        list.appendChild(empty);
      }

      let lastNameInput = null;
      let lastRow = null;
      working.forEach((entry, idx) => {
        const row = doc.createElement('div');
        row.className = 'classic-lore-entry-row';

        const top = doc.createElement('div');
        top.className = 'classic-lore-entry-top';

        const nameIn = doc.createElement('input');
        nameIn.type = 'text';
        nameIn.className = 'classic-lore-name-input';
        nameIn.value = entry.name;
        nameIn.placeholder = 'Entry name';
        nameIn.addEventListener('input', () => { working[idx].name = nameIn.value; });

        const constLbl = doc.createElement('label');
        constLbl.className = 'classic-lore-const-label';
        const constCb = doc.createElement('input');
        constCb.type = 'checkbox';
        constCb.checked = entry.constant;
        constCb.addEventListener('change', () => { working[idx].constant = constCb.checked; });
        constLbl.append(constCb, doc.createTextNode(' Always on'));

        const delEntryBtn = doc.createElement('button');
        delEntryBtn.type = 'button';
        delEntryBtn.className = 'action-icon-btn';
        delEntryBtn.title = 'Delete entry';
        delEntryBtn.setAttribute('aria-label', `Delete entry ${entry.name || idx + 1}`);
        delEntryBtn.innerHTML = TRASH_SVG;
        delEntryBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          working.splice(idx, 1);
          redraw(false);
        });

        top.append(nameIn, constLbl, delEntryBtn);

        const keysIn = doc.createElement('input');
        keysIn.type = 'text';
        keysIn.className = 'onboarding-input';
        keysIn.value = entry.keys;
        keysIn.placeholder = 'Keywords (comma-separated)';
        keysIn.addEventListener('input', () => { working[idx].keys = keysIn.value; });

        const contentTa = doc.createElement('textarea');
        contentTa.className = 'onboarding-input';
        contentTa.rows = 3;
        contentTa.value = entry.content;
        contentTa.placeholder = 'Content injected into context when triggered';
        contentTa.addEventListener('input', () => { working[idx].content = contentTa.value; });

        row.append(top, keysIn, contentTa);
        list.appendChild(row);
        lastNameInput = nameIn;
        lastRow = row;
      });

      const footer = doc.createElement('div');
      footer.className = 'classic-lore-footer';

      const addBtn = doc.createElement('button');
      addBtn.type = 'button';
      addBtn.className = 'dashed-action-btn';
      addBtn.style.width = 'auto';
      addBtn.textContent = '+ Add Entry';
      addBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        working.push({
          keys: '',
          secondary_keys: '',
          content: '',
          constant: false,
          enabled: true,
          name: 'New Entry',
          insertion_order: 100,
          position: 'before_char',
          _raw: {},
        });
        redraw(true);
      });

      const saveBtn = doc.createElement('button');
      saveBtn.type = 'button';
      saveBtn.className = 'onboarding-btn';
      saveBtn.textContent = 'Save';
      saveBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const payload = working.map((w) => ({
          ...(w._raw || {}),
          name: w.name,
          keys: w.keys.split(',').map((k) => k.trim()).filter(Boolean),
          secondary_keys: w.secondary_keys.split(',').map((k) => k.trim()).filter(Boolean),
          content: w.content,
          constant: w.constant,
          enabled: w.enabled,
          insertion_order: w.insertion_order,
          position: w.position,
        }));
        saveBtn.disabled = true;
        saveBtn.textContent = 'Saving...';
        try {
          const res = isCardBook
            ? await saveCardLorebookEntries(payload)
            : await saveLorebookEntries(filename, { entries: payload });
          if (res?.error || res?.success === false) {
            throw new Error(res?.error || 'Failed to save lorebook entries.');
          }
          onSavedEntries?.(payload);
          const activeCount = payload.filter((it) => it.enabled !== false && String(it.content || '').trim()).length;
          onCountChanged?.(activeCount);
          saveBtn.textContent = 'Saved ✓';
          setTimeout(() => { saveBtn.textContent = 'Save'; }, 1800);
        } catch (err) {
          saveBtn.textContent = 'Save';
          showAlert('Save Failed', err?.message || 'Unknown error');
        } finally {
          saveBtn.disabled = false;
        }
      });

      footer.append(addBtn, saveBtn);
      panel.append(list, footer);

      if (focusNew && lastRow) {
        lastRow.scrollIntoView?.({ block: 'nearest' });
        lastNameInput?.focus?.();
      }
    };

    redraw(false);
  }

  async function renderLorebooksTab(epoch = tabEpoch) {
    const data = await fetchLorebooks().catch(() => ({ lorebooks: [] }));
    if (closed || activeTab !== 'lorebooks' || epoch !== tabEpoch) return;

    const books = data?.lorebooks || [];
    const wrap = doc.createElement('div');
    wrap.className = 'classic-cards-stack';

    const loreIn = doc.createElement('input');
    loreIn.type = 'file';
    loreIn.id = 'lorebook-file-input';
    loreIn.accept = '.json,application/json';
    loreIn.className = 'visually-hidden';
    loreIn.hidden = true;
    loreIn.addEventListener('change', async () => {
      const f = loreIn.files?.[0];
      if (!f) return;
      try {
        const res = await importLorebookFile(f);
        if (res?.error) throw new Error(res.error);
        loreIn.value = '';
        void loadTab();
      } catch (err) {
        showAlert('Import Failed', err?.message || 'Failed to import lorebook.');
      }
    });

    const impBtn = doc.createElement('button');
    impBtn.type = 'button';
    impBtn.className = 'dashed-action-btn';
    impBtn.style.display = 'block';
    impBtn.style.textAlign = 'center';
    impBtn.textContent = '+ Import Lorebook .json';
    impBtn.addEventListener('click', () => loreIn.click());

    const sectHead = doc.createElement('div');
    sectHead.className = 'modal-section-header';
    sectHead.textContent = 'Active Lorebooks';

    const cardsWrap = doc.createElement('div');
    cardsWrap.className = 'classic-cards-stack';

    if (books.length === 0) {
      const empty = doc.createElement('div');
      empty.className = 'empty-state';
      empty.textContent = 'No lorebooks loaded. Import a SillyTavern World Info JSON to get started.';
      cardsWrap.appendChild(empty);
    } else {
      for (const book of books) {
        const card = doc.createElement('div');
        card.className = 'classic-lorebook-card';

        const header = doc.createElement('div');
        header.className = 'classic-lorebook-header';

        const toggleBtn = doc.createElement('button');
        toggleBtn.type = 'button';
        toggleBtn.className = 'classic-lorebook-toggle';
        toggleBtn.setAttribute('aria-expanded', 'false');

        const titleEl = doc.createElement('div');
        titleEl.style.fontWeight = '500';
        titleEl.textContent = book.name || book.filename || 'Lorebook';
        const sub = doc.createElement('div');
        sub.className = 'classic-card-subtext';
        const formatSub = (cnt) =>
          `${cnt} entr${cnt === 1 ? 'y' : 'ies'} · ${book.source === 'card' ? 'embedded in card' : 'standalone file'}`;
        sub.textContent = formatSub(book.entry_count ?? 0);
        toggleBtn.append(titleEl, sub);

        const acts = doc.createElement('div');
        acts.className = 'classic-card-actions';

        const expBtn = doc.createElement('button');
        expBtn.type = 'button';
        expBtn.className = 'action-icon-btn';
        expBtn.title = 'Export lorebook';
        expBtn.setAttribute('aria-label', `Export ${book.name || book.filename || 'lorebook'}`);
        expBtn.innerHTML = EXPORT_SVG;
        expBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          const url = book.source === 'card'
            ? `/api/programs/${encodeURIComponent(book.program_id || programId)}/export/lorebook`
            : `/api/lorebooks/${encodeURIComponent(book.filename)}/export`;
          const fname = book.source === 'card'
            ? `${book.program_id || programId}_lorebook.json`
            : (book.filename || 'lorebook.json');
          void downloadNodeFile(url, fname);
        });
        acts.appendChild(expBtn);

        if (book.source === 'file') {
          const delBtn = doc.createElement('button');
          delBtn.type = 'button';
          delBtn.className = 'action-icon-btn';
          delBtn.title = 'Delete lorebook';
          delBtn.setAttribute('aria-label', `Delete ${book.name || book.filename}`);
          delBtn.innerHTML = TRASH_SVG;
          delBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            showConfirm('Delete Lorebook', `Delete lorebook "${book.name || book.filename}"?`, async () => {
              try {
                const res = await deleteLorebookFile(book.filename);
                if (res?.error || res?.success === false) {
                  throw new Error(res?.error || 'Unable to delete lorebook.');
                }
                await loadTab();
              } catch (err) {
                showAlert('Delete Failed', err?.message || 'Unable to delete lorebook.');
              }
            });
          });
          acts.appendChild(delBtn);
        }

        const chevron = doc.createElement('span');
        chevron.className = 'classic-lore-chevron';
        chevron.textContent = '▸';
        acts.appendChild(chevron);

        header.append(toggleBtn, acts);

        const panel = doc.createElement('div');
        panel.className = 'classic-lorebook-panel';
        panel.hidden = true;

        let expanded = false;
        let entriesCache = null;

        const toggleExpand = async () => {
          expanded = !expanded;
          toggleBtn.setAttribute('aria-expanded', expanded ? 'true' : 'false');
          panel.hidden = !expanded;
          chevron.classList.toggle('is-open', expanded);
          if (expanded && entriesCache === null) {
            panel.replaceChildren(createLoadingState('Loading entries…', { doc, compact: true }));
            try {
              const res = book.source === 'card'
                ? await fetchCardLorebookEntries()
                : await fetchLorebookEntries(book.filename);
              entriesCache = Array.isArray(res?.entries) ? res.entries : [];
            } catch (err) {
              entriesCache = [];
              showAlert('Load Failed', err?.message || 'Unable to load lorebook entries.');
            }
            if (closed || activeTab !== 'lorebooks' || epoch !== tabEpoch) return;
            renderEntriesEditor(panel, entriesCache, book.source === 'card', book.filename, {
              onSavedEntries: (updated) => {
                entriesCache = updated;
              },
              onCountChanged: (cnt) => {
                sub.textContent = formatSub(cnt);
              },
            });
          }
        };

        toggleBtn.addEventListener('click', () => void toggleExpand());
        chevron.addEventListener('click', () => void toggleExpand());

        card.append(header, panel);
        cardsWrap.appendChild(card);
      }
    }

    const loreSection = doc.createElement('div');
    loreSection.className = 'classic-section-divider';
    loreSection.append(sectHead, cardsWrap);

    wrap.append(loreIn, impBtn, loreSection);
    bodyHost.replaceChildren(wrap);
  }

  async function loadTab() {
    const epoch = ++tabEpoch;
    uploadBtn.classList.toggle('active', activeTab === 'upload');
    memBtn.classList.toggle('active', activeTab === 'memories');
    loreBtn.classList.toggle('active', activeTab === 'lorebooks');
    descriptorEl.textContent = DESCRIPTORS[activeTab] || '';
    bodyHost.replaceChildren(createLoadingState('Loading knowledge base…', { doc, compact: true }));

    await ensureActiveProgram();
    if (closed || epoch !== tabEpoch) return;
    if (activeTab === 'upload') await renderDataBankTab(epoch);
    else if (activeTab === 'memories') await renderJournalsTab(epoch);
    else await renderLorebooksTab(epoch);
  }

  uploadBtn.addEventListener('click', () => { activeTab = 'upload'; void loadTab(); });
  memBtn.addEventListener('click', () => { activeTab = 'memories'; void loadTab(); });
  loreBtn.addEventListener('click', () => { activeTab = 'lorebooks'; void loadTab(); });

  modal.open();
  void loadTab();
  return modal;
}
