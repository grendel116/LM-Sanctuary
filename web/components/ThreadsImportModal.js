import {
  cancelThreadsArchiveSync,
  downloadThreadsArchiveCsv,
  getThreadsImportState,
  parseThreadsArchiveFile,
  startThreadsArchiveSync,
} from '../queries/threadsArchive.js';
import { authStore } from '../state/authStore.js';
import { createClassicModalDialog } from './sanctuary/SanctuaryDialog.js';

const CSV_EXPORTS = [
  ['mutuals', 'Mutuals CSV'],
  ['following', 'Following CSV'],
];

const FOLLOW_SCOPE_OPTIONS = [
  ['mutuals', 'mutuals', 'Follow Mutuals on @threads.net'],
  ['following', 'following', 'Follow Everyone I Follow on @threads.net'],
];

/**
 * Dialog for importing Following & Mutuals from a Meta Threads data-export ZIP
 * for Mastodon CSV export or paced @threads.net following.
 */
export function openThreadsImportModal({ onImported } = {}) {
  const doc = globalThis.document;
  let closed = false;
  let pollTimer = null;
  let archiveState = null;
  let jobState = { status: 'idle', total: 0, processed: 0, followed: 0, notFederated: 0, errors: 0 };

  const modal = createClassicModalDialog({
    id: 'threads-import-dialog',
    maxWidth: '560px',
    onClose: () => {
      closed = true;
      clearTimeout(pollTimer);
      pollTimer = null;
      modal.dialog.remove();
    },
  });

  const heading = doc.createElement('h3');
  heading.id = modal.titleId;
  heading.className = 'classic-modal-title';
  heading.textContent = 'Import Threads Follows (.zip)';

  const intro = doc.createElement('p');
  intro.className = 'classic-modal-desc';
  intro.textContent = 'Reads following and mutuals from your Threads ZIP for Mastodon CSV import or @threads.net following.';

  const scrollBody = doc.createElement('div');
  scrollBody.className = 'classic-modal-scroll-body';

  // Section 1: ZIP File Upload & CSV Exports
  const fileCard = doc.createElement('div');
  fileCard.className = 'form-card-container account-login-card';

  const fileLbl = doc.createElement('label');
  fileLbl.setAttribute('for', 'threads-archive-file-input');
  fileLbl.className = 'threads-import-field-label';
  fileLbl.textContent = 'Meta Threads Export Archive (.zip)';

  const fileIn = doc.createElement('input');
  fileIn.type = 'file';
  fileIn.id = 'threads-archive-file-input';
  fileIn.name = 'threads_archive_zip';
  fileIn.accept = '.zip,application/zip';
  fileIn.className = 'onboarding-input threads-import-file-input';

  const summaryBox = doc.createElement('div');
  summaryBox.className = 'threads-import-summary';

  const csvRow = doc.createElement('div');
  csvRow.className = 'threads-import-csv-row';
  const csvButtons = [];
  for (const [kind, label] of CSV_EXPORTS) {
    const btn = doc.createElement('button');
    btn.type = 'button';
    btn.className = 'edit-btn edit-cancel-btn threads-import-csv-btn';
    btn.dataset.csvKind = kind;
    btn.textContent = label;
    btn.disabled = true;
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        await downloadThreadsArchiveCsv(kind);
        setStatus(`Exported mastodon_threads_${kind}.csv`);
      } catch (err) {
        setStatus(err?.message || 'CSV export failed.');
      } finally {
        syncUi();
      }
    });
    csvButtons.push({ kind, btn });
    csvRow.appendChild(btn);
  }

  fileCard.append(fileLbl, fileIn, summaryBox, csvRow);

  // Section 2: Follow Scope Form
  const form = doc.createElement('form');
  form.className = 'form-card-container account-login-card';
  form.setAttribute('aria-labelledby', modal.titleId);

  const scopeFieldset = doc.createElement('fieldset');
  scopeFieldset.className = 'threads-import-fieldset';
  const scopeLegend = doc.createElement('legend');
  scopeLegend.textContent = 'Follow on Mastodon (@user@threads.net)';
  scopeFieldset.appendChild(scopeLegend);

  const scopeCountLabels = new Map();
  for (const [val, countKey, baseText] of FOLLOW_SCOPE_OPTIONS) {
    const optRow = doc.createElement('div');
    optRow.className = 'threads-import-radio-row';
    const radio = doc.createElement('input');
    radio.type = 'radio';
    radio.id = `threads-scope-${val}`;
    radio.name = 'threads_follow_scope';
    radio.value = val;
    radio.checked = val === 'mutuals';
    radio.setAttribute('type', 'radio');
    radio.setAttribute('name', 'threads_follow_scope');

    const lbl = doc.createElement('label');
    lbl.setAttribute('for', radio.id);
    lbl.textContent = baseText;
    scopeCountLabels.set(countKey, { lbl, baseText });
    optRow.append(radio, lbl);
    scopeFieldset.appendChild(optRow);
  }

  const progressGroup = doc.createElement('div');
  progressGroup.className = 'threads-import-progress-group';
  progressGroup.hidden = true;

  const progressLbl = doc.createElement('label');
  progressLbl.setAttribute('for', 'threads-import-progress-bar');
  progressLbl.className = 'classic-card-subtext';
  progressLbl.textContent = 'Sync Progress';

  const progressBar = doc.createElement('progress');
  progressBar.id = 'threads-import-progress-bar';
  progressBar.className = 'threads-import-progress';

  progressGroup.append(progressLbl, progressBar);

  const statusEl = doc.createElement('p');
  statusEl.className = 'classic-modal-status threads-import-status';
  statusEl.setAttribute('role', 'status');
  statusEl.setAttribute('aria-live', 'polite');

  const btnRow = doc.createElement('div');
  btnRow.className = 'classic-card-actions';

  const cancelJobBtn = doc.createElement('button');
  cancelJobBtn.type = 'button';
  cancelJobBtn.className = 'edit-btn edit-cancel-btn';
  cancelJobBtn.textContent = 'Stop Sync';
  cancelJobBtn.hidden = true;

  const submitBtn = doc.createElement('button');
  submitBtn.type = 'submit';
  submitBtn.className = 'btn-sleek-pill';
  submitBtn.textContent = 'Follow on Mastodon';
  submitBtn.disabled = true;

  btnRow.append(cancelJobBtn, submitBtn);
  form.append(scopeFieldset, progressGroup, statusEl, btnRow);

  function setStatus(msg) {
    statusEl.textContent = String(msg || '');
  }

  function formatJobSummary(job) {
    if (!job || job.status === 'idle') return '';
    const prefix = job.status === 'running'
      ? `Following ${job.currentHandle || '…'}:`
      : (job.status === 'cancelled'
          ? 'Sync stopped:'
          : (job.status === 'error' ? `Sync error (${job.errorMessage || 'failed'}):` : 'Sync complete:'));
    return `${prefix} ${job.processed || 0}/${job.total || 0} checked · ${job.followed || 0} followed · ${job.notFederated || 0} not federated`;
  }

  function syncUi() {
    if (closed) return;
    const counts = archiveState?.counts || null;
    summaryBox.replaceChildren();
    if (counts) {
      const metaP = doc.createElement('p');
      metaP.className = 'classic-card-subtext';
      metaP.style.margin = '0 0 6px';
      metaP.textContent = `Loaded: ${archiveState.sourceName || 'threads-export.zip'}`;
      summaryBox.appendChild(metaP);

      const pills = doc.createElement('div');
      pills.className = 'threads-import-pills';
      const stats = [
        ['Mutuals', counts.mutuals || 0],
        ['Following', counts.following || 0],
      ];
      for (const [k, v] of stats) {
        const pill = doc.createElement('span');
        pill.className = 'threads-import-count-pill';
        pill.textContent = `${k}: ${Number(v).toLocaleString()}`;
        pills.appendChild(pill);
      }
      summaryBox.appendChild(pills);

      for (const [key, entry] of scopeCountLabels.entries()) {
        entry.lbl.textContent = `${entry.baseText} (${Number(counts[key] || 0).toLocaleString()})`;
      }
    } else {
      const hint = doc.createElement('p');
      hint.className = 'classic-card-subtext';
      hint.textContent = 'Select your Threads ZIP archive above.';
      summaryBox.appendChild(hint);
    }

    for (const { kind, btn } of csvButtons) {
      btn.disabled = !counts || !(counts[kind] > 0);
    }

    const isRunning = jobState?.status === 'running';
    submitBtn.disabled = !counts || isRunning;
    cancelJobBtn.hidden = !isRunning;

    if (isRunning || (jobState?.total > 0 && jobState?.status !== 'idle')) {
      progressGroup.hidden = false;
      if (jobState.total > 0) {
        progressBar.max = jobState.total;
        progressBar.value = Math.min(jobState.processed || 0, jobState.total);
      } else {
        progressBar.removeAttribute('value');
      }
      progressLbl.textContent = jobState.total > 0
        ? `Progress: ${jobState.processed || 0} / ${jobState.total}`
        : 'Preparing sync…';
    } else {
      progressGroup.hidden = true;
    }

    if (jobState && jobState.status !== 'idle' && !statusEl.dataset.manualOverride) {
      setStatus(formatJobSummary(jobState));
    }
  }

  function schedulePoll() {
    clearTimeout(pollTimer);
    if (closed || jobState?.status !== 'running') return;
    pollTimer = setTimeout(async () => {
      if (closed) return;
      try {
        const res = await getThreadsImportState();
        if (closed) return;
        if (res?.archive) archiveState = res.archive;
        if (res?.job) jobState = res.job;
        syncUi();
        if (jobState?.status === 'running') {
          schedulePoll();
        } else {
          await onImported?.(archiveState);
        }
      } catch {
        schedulePoll();
      }
    }, 900);
  }

  fileIn.addEventListener('change', async () => {
    const file = fileIn.files?.[0];
    if (!file) return;
    delete statusEl.dataset.manualOverride;
    submitBtn.disabled = true;
    progressGroup.hidden = false;
    progressBar.removeAttribute('value');
    progressLbl.textContent = 'Parsing archive…';
    setStatus('Reading archive…');
    try {
      const parsed = await parseThreadsArchiveFile(file);
      archiveState = {
        sourceName: parsed.sourceName || file.name,
        importedAt: parsed.importedAt || Date.now(),
        counts: parsed.counts || {},
      };
      if (parsed.job) jobState = parsed.job;
      setStatus(`Loaded ${parsed.counts?.mutuals || 0} mutuals and ${parsed.counts?.following || 0} following.`);
      await onImported?.(archiveState);
    } catch (err) {
      setStatus(err?.message || 'Unable to parse Threads archive.');
    } finally {
      syncUi();
    }
  });

  cancelJobBtn.addEventListener('click', async () => {
    cancelJobBtn.disabled = true;
    try {
      delete statusEl.dataset.manualOverride;
      jobState = await cancelThreadsArchiveSync();
      clearTimeout(pollTimer);
    } finally {
      cancelJobBtn.disabled = false;
      syncUi();
    }
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    delete statusEl.dataset.manualOverride;
    const checkedRadio = Array.from(scopeFieldset.querySelectorAll('input')).find(
      (el) => el.name === 'threads_follow_scope' && el.checked
    );
    const selectedScope = checkedRadio?.value === 'following' ? 'following' : 'mutuals';
    if (!authStore.get().isMastodonConnected) {
      statusEl.dataset.manualOverride = '1';
      setStatus('Connect Mastodon under Accounts & Bridges first.');
      return;
    }

    submitBtn.disabled = true;
    try {
      jobState = await startThreadsArchiveSync({ followScope: selectedScope });
      await onImported?.(archiveState);
      syncUi();
      if (jobState?.status === 'running') {
        schedulePoll();
      }
    } catch (err) {
      statusEl.dataset.manualOverride = '1';
      setStatus(err?.message || 'Follow sync failed.');
      syncUi();
    }
  });

  scrollBody.append(fileCard, form);
  modal.card.append(heading, intro, scrollBody);
  syncUi();
  modal.open();

  void getThreadsImportState()
    .then((state) => {
      if (closed) return;
      if (state?.archive) archiveState = state.archive;
      if (state?.job) jobState = state.job;
      syncUi();
      if (jobState?.status === 'running') schedulePoll();
    })
    .catch(() => {});

  return modal;
}
