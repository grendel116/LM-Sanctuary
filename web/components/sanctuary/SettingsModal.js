import { DEFAULT_AVATAR_DATA_URI } from '../../constants/avatars.js';
import { SEARCH_ENGINES, normalizeSearchEngineId } from '../../core/urlPrivacy.js';
import { formatApiErrorMessage } from '../../queries/fetch/fetchWrapper.js';
import {
  browseWorkspaceFolder,
  controlOpenHandsServer,
  fetchNativeModels,
  fetchOpenHandsServerStatus,
  fetchProjectSettings,
  loadNativeLlm,
  openModelsFolder,
  saveGenerationParams,
  saveProjectSettings,
  selectNativeCheckpoint,
  selectNativeWorkflow,
} from '../../queries/sanctuary.js';
import {
  addKeywordFilter,
  fetchKeywordFilters,
  fetchModerationAccounts,
  isUnifiedPublicDiscoveryEnabled,
  peekCachedModerationAccounts,
  removeKeywordFilter,
  removeModeratedAccount,
  setUnifiedPublicDiscovery,
  toggleBlockAuthor,
  toggleMuteAuthor,
} from '../../queries/socialClient.js';
import { authStore } from '../../state/authStore.js';
import { feedStore } from '../../state/feedStore.js';
import { browserStore, setSearchConfig } from '../../state/browserStore.js';
import {
  checkSanctuaryHealth,
  connectionStore,
  setSanctuaryBasicAuth,
  setSanctuaryNodeUrl,
} from '../../state/sanctuary/connection.js';
import { flushOutbox, outboxStore } from '../../state/sanctuary/outboxModel.js';
import { openFeedTuningModal } from '../FeedTuningModal.js';
import { createLoadingState } from '../ui/index.js';
import { createClassicModalDialog, showAlert, showPrompt } from './SanctuaryDialog.js';

const SETTINGS_SVG = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--primary-accent)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="4" y1="21" x2="4" y2="14"></line><line x1="4" y1="10" x2="4" y2="3"></line><line x1="12" y1="21" x2="12" y2="12"></line><line x1="12" y1="8" x2="12" y2="3"></line><line x1="20" y1="21" x2="20" y2="16"></line><line x1="20" y1="12" x2="20" y2="3"></line><line x1="1" y1="14" x2="7" y2="14"></line><line x1="9" y1="8" x2="15" y2="8"></line><line x1="17" y1="16" x2="23" y2="16"></line></svg>`;
const FOLDER_SVG = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>`;

const TAB_DESCRIPTORS = {
  engine: 'Select local chat and image models.',
  project: 'Workspace folders, execution policy, search, and node connection.',
  moderation: 'Keyword filters, public discovery, feed ranking, mutes, and blocks.',
};

function normalizeSecurityPreset(raw) {
  if (raw === 'turbo' || raw === 'auto_approve' || raw === 'auto') return 'auto';
  return 'ask_always';
}

/**
 * Left-Rail Connection & Project Settings modal (Models | Project | Moderation).
 */
export function openSettingsModal({
  initialTab = 'engine',
  temperature = 0.95,
  onSettingsChanged,
} = {}) {
  const doc = globalThis.document;
  const resolvedInitial = initialTab === 'node' ? 'project' : initialTab;
  let activeTab = TAB_DESCRIPTORS[resolvedInitial] ? resolvedInitial : 'engine';
  let nodeStatusRefs = null;
  let currentTemp = Number.isFinite(Number(temperature)) ? Number(temperature) : 0.95;
  let nativeInfo = null;
  let openHandsServerInfo = null;
  let projectSettings = {
    folders: [],
    security_preset: 'ask_always',
    artifact_review_policy: 'ask_always',
    greenpt_api_key: '',
    greenpt_base_url: 'https://api.greenpt.ai/v1',
    openhands_model: 'glm-5.3',
    cloud_fast_model: '',
    cloud_vision_model: '',
    cloud_private_model: '',
    openhands_mode: 'auto',
    openhands_server_port: 8091,
    openhands_auto_start_server: false,
    searxng_url: '',
    browser_search_engine: '',
    browser_custom_search_url: '',
    tts_voice: 'af_heart',
  };
  let closed = false;
  const dirtyFields = new Set();
  let flushPendingKeySave = null;

  async function patchProjectSettings(patch, { rerender = false } = {}) {
    for (const key of Object.keys(patch)) {
      dirtyFields.add(key);
    }
    Object.assign(projectSettings, patch);
    const res = await saveProjectSettings(patch);
    if (res?.settings) {
      projectSettings = { ...res.settings };
      for (const key of Object.keys(patch)) {
        projectSettings[key] = patch[key];
      }
    }
    await onSettingsChanged?.(projectSettings);
    if (rerender && !closed && activeTab === 'project') {
      renderProjectTab();
    }
    return res;
  }

  const modal = createClassicModalDialog({
    id: 'connection-settings-dialog',
    maxWidth: '560px',
    onClose: () => {
      closed = true;
      flushPendingKeySave?.();
      unsubConn();
      unsubOut();
      modal.dialog.remove();
    },
  });

  const heading = doc.createElement('h3');
  heading.id = modal.titleId;
  heading.className = 'classic-modal-title';
  heading.innerHTML = `${SETTINGS_SVG}<span>Connection & Project Settings</span>`;

  const tabBar = doc.createElement('div');
  tabBar.className = 'classic-modal-tabs';
  const engineBtn = doc.createElement('button');
  engineBtn.type = 'button';
  engineBtn.className = 'modal-tab-btn';
  engineBtn.textContent = 'Models';
  const projBtn = doc.createElement('button');
  projBtn.type = 'button';
  projBtn.className = 'modal-tab-btn';
  projBtn.textContent = 'Project';
  const modBtn = doc.createElement('button');
  modBtn.type = 'button';
  modBtn.className = 'modal-tab-btn';
  modBtn.textContent = 'Moderation';
  tabBar.append(engineBtn, projBtn, modBtn);

  const descriptorEl = doc.createElement('p');
  descriptorEl.id = 'connection-descriptor';
  descriptorEl.className = 'classic-modal-desc';

  const bodyHost = doc.createElement('div');
  bodyHost.className = 'classic-modal-scroll-body';

  modal.card.append(heading, tabBar, descriptorEl, bodyHost);

  function renderModelsTab() {
    const wrap = doc.createElement('div');
    wrap.className = 'classic-cards-stack';

    // Temperature Slider Card
    const tempBox = doc.createElement('div');
    tempBox.className = 'onboarding-option-box';
    const tempTop = doc.createElement('div');
    tempTop.className = 'option-header';
    const tempTitle = doc.createElement('span');
    tempTitle.style.fontSize = '0.85rem';
    tempTitle.style.fontWeight = '600';
    const tempValSpan = doc.createElement('span');
    tempValSpan.style.color = 'var(--primary-accent)';
    tempValSpan.textContent = String(currentTemp);
    tempTitle.append(doc.createTextNode('Temperature: '), tempValSpan);
    const tempHint = doc.createElement('span');
    tempHint.style.fontSize = '0.7rem';
    tempHint.style.color = 'var(--text-muted)';
    tempHint.textContent = 'Higher is creative, lower is stable';
    tempTop.append(tempTitle, tempHint);

    const slider = doc.createElement('input');
    slider.type = 'range';
    slider.id = 'dynamism-slider';
    slider.className = 'sanctuary-range';
    slider.min = '0.50';
    slider.max = '1.80';
    slider.step = '0.05';
    slider.value = String(currentTemp);
    slider.setAttribute('aria-label', 'Temperature');
    slider.addEventListener('input', () => {
      currentTemp = Number.parseFloat(slider.value);
      tempValSpan.textContent = slider.value;
    });
    slider.addEventListener('change', async () => {
      const val = Number.parseFloat(slider.value);
      await saveGenerationParams(val);
      await onSettingsChanged?.({ temperature: val });
    });
    tempBox.append(tempTop, slider);
    wrap.appendChild(tempBox);

    const ggufs = nativeInfo?.gguf_models || [];
    const ckpts = nativeInfo?.checkpoints || [];
    const loras = nativeInfo?.loras || [];
    const workflows = nativeInfo?.workflows || [];
    const isNodeOnline = connectionStore.get().mode === 'online';
    const isLoadingModels = isNodeOnline && nativeInfo === null;

    // Native LLM Panel
    const llmBox = doc.createElement('div');
    llmBox.className = 'onboarding-option-box';
    const llmHead = doc.createElement('div');
    llmHead.className = 'option-header';
    const llmTitle = doc.createElement('h4');
    llmTitle.style.margin = '0';
    llmTitle.textContent = 'LLM Model';
    const llmBadge = doc.createElement('span');
    llmBadge.className = `status-badge ${ggufs.length > 0 ? 'status-online' : 'status-offline'}`;
    llmBadge.textContent = ggufs.length > 0
      ? 'Online'
      : (!isNodeOnline ? 'Server Offline' : (isLoadingModels ? 'Loading…' : 'No Models'));
    llmHead.append(llmTitle, llmBadge);

    const llmDesc = doc.createElement('p');
    llmDesc.className = 'option-desc';
    llmDesc.textContent = 'Runs GGUF chat models from sanctuary/models/llm/.';

    const llmGrp = doc.createElement('div');
    llmGrp.className = 'input-group';
    const llmLbl = doc.createElement('label');
    llmLbl.setAttribute('for', 'native-llm-select');
    llmLbl.textContent = 'Active Chat Model';
    const llmSelect = doc.createElement('select');
    llmSelect.id = 'native-llm-select';
    llmSelect.className = 'onboarding-input glass-select';

    if (ggufs.length === 0) {
      const opt = doc.createElement('option');
      opt.value = '';
      opt.textContent = !isNodeOnline
        ? 'Sanctuary server offline — start server to load models'
        : (isLoadingModels ? 'Loading local models…' : 'No .gguf models found');
      llmSelect.appendChild(opt);
    } else {
      for (const m of ggufs) {
        const fname = typeof m === 'string' ? m : m.filename;
        const mName = typeof m === 'string' ? m : (m.name || m.filename);
        const sizeStr = typeof m === 'object' && m.size_gb !== undefined ? ` (${m.size_gb} GB)` : '';
        const opt = doc.createElement('option');
        opt.value = fname;
        opt.textContent = `${mName}${sizeStr}`;
        if (nativeInfo?.active_llm === fname || nativeInfo?.active_llm === mName) {
          opt.selected = true;
        }
        llmSelect.appendChild(opt);
      }
    }
    llmSelect.addEventListener('change', async () => {
      if (!llmSelect.value) return;
      const res = await loadNativeLlm({ model_name: llmSelect.value });
      if (res?.success) {
        showAlert('Model Active', `Loaded '${res.active_model}' for in-process chat.`);
      }
    });
    llmGrp.append(llmLbl, llmSelect);

    const openLlmBtn = doc.createElement('button');
    openLlmBtn.type = 'button';
    openLlmBtn.className = 'onboarding-btn';
    openLlmBtn.style.cssText = 'width: 100%; display: inline-flex; align-items: center; justify-content: center; gap: 6px;';
    openLlmBtn.innerHTML = `${FOLDER_SVG}<span>Open LLM Folder</span>`;
    openLlmBtn.addEventListener('click', () => void openModelsFolder('llm'));

    llmBox.append(llmHead, llmDesc, llmGrp, openLlmBtn);
    wrap.appendChild(llmBox);

    // Native Image Generation Panel
    const diffBox = doc.createElement('div');
    diffBox.className = 'onboarding-option-box';
    const diffHead = doc.createElement('div');
    diffHead.className = 'option-header';
    const diffTitle = doc.createElement('h4');
    diffTitle.style.margin = '0';
    diffTitle.textContent = 'Image Generation';
    const diffBadge = doc.createElement('span');
    diffBadge.className = `status-badge ${ckpts.length > 0 ? 'status-online' : 'status-offline'}`;
    diffBadge.textContent = ckpts.length > 0
      ? 'Online'
      : (!isNodeOnline ? 'Server Offline' : (isLoadingModels ? 'Loading…' : 'No Checkpoints'));
    diffHead.append(diffTitle, diffBadge);

    const diffDesc = doc.createElement('p');
    diffDesc.className = 'option-desc';
    diffDesc.textContent = 'Renders portraits from sanctuary/models/checkpoints/ and workflows/.';

    const ckptGrp = doc.createElement('div');
    ckptGrp.className = 'input-group';
    const ckptLbl = doc.createElement('label');
    ckptLbl.setAttribute('for', 'native-diffusion-select');
    ckptLbl.textContent = 'Active Checkpoint Model';
    const ckptSelect = doc.createElement('select');
    ckptSelect.id = 'native-diffusion-select';
    ckptSelect.className = 'onboarding-input glass-select';
    if (ckpts.length === 0) {
      const opt = doc.createElement('option');
      opt.value = '';
      opt.textContent = !isNodeOnline
        ? 'Sanctuary server offline — start server to load checkpoints'
        : (isLoadingModels ? 'Loading local checkpoints…' : 'No SafeTensors checkpoints found');
      ckptSelect.appendChild(opt);
    } else {
      for (const c of ckpts) {
        const fname = typeof c === 'string' ? c : c.filename;
        const cName = typeof c === 'string' ? c : (c.name || c.filename);
        const sizeStr = typeof c === 'object' && c.size_gb !== undefined ? ` (${c.size_gb} GB)` : '';
        const opt = doc.createElement('option');
        opt.value = fname;
        opt.textContent = `${cName}${sizeStr}`;
        if (nativeInfo?.active_checkpoint === fname || nativeInfo?.active_checkpoint === cName) {
          opt.selected = true;
        }
        ckptSelect.appendChild(opt);
      }
    }
    ckptSelect.addEventListener('change', async () => {
      if (!ckptSelect.value) return;
      const res = await selectNativeCheckpoint(ckptSelect.value);
      if (res?.success) {
        showAlert('Checkpoint Active', `Selected checkpoint '${res.active_checkpoint}' for native portrait generation.`);
      }
    });
    ckptGrp.append(ckptLbl, ckptSelect);

    const wfGrp = doc.createElement('div');
    wfGrp.className = 'input-group';
    const wfLbl = doc.createElement('label');
    wfLbl.setAttribute('for', 'native-workflow-select');
    wfLbl.textContent = 'Active Image Workflow';
    const wfSelect = doc.createElement('select');
    wfSelect.id = 'native-workflow-select';
    wfSelect.className = 'onboarding-input glass-select';
    const wfPool = workflows.length > 0 ? workflows : [{ filename: 'ImageWorkflow.json', name: 'ImageWorkflow (Default)' }];
    for (const w of wfPool) {
      const fname = typeof w === 'string' ? w : w.filename;
      const wName = typeof w === 'string' ? w : (w.name || w.filename);
      const sizeStr = typeof w === 'object' && w.size_kb !== undefined ? ` (${w.size_kb} KB)` : '';
      const opt = doc.createElement('option');
      opt.value = fname;
      opt.textContent = `${wName}${sizeStr}`;
      if (nativeInfo?.active_workflow === fname || nativeInfo?.active_workflow === wName) {
        opt.selected = true;
      }
      wfSelect.appendChild(opt);
    }
    wfSelect.addEventListener('change', async () => {
      if (!wfSelect.value) return;
      const res = await selectNativeWorkflow(wfSelect.value);
      if (res?.success) {
        showAlert('Workflow Active', `Selected workflow '${res.active_workflow}' for image generation.`);
      }
    });
    wfGrp.append(wfLbl, wfSelect);

    const summaryEl = doc.createElement('p');
    summaryEl.className = 'option-desc';
    summaryEl.textContent = `${ckpts.length} checkpoint(s) · ${loras.length} LoRA(s) · ${workflows.length} workflow(s)`;

    const folderBtns = doc.createElement('div');
    folderBtns.className = 'classic-modal-tabs';
    for (const [key, lbl] of [['checkpoints', 'Checkpoints'], ['loras', 'LoRAs'], ['workflows', 'Workflows']]) {
      const b = doc.createElement('button');
      b.type = 'button';
      b.className = 'onboarding-btn';
      b.style.cssText = 'flex: 1; display: inline-flex; align-items: center; justify-content: center; gap: 6px;';
      b.innerHTML = `${FOLDER_SVG}<span>${lbl}</span>`;
      b.addEventListener('click', () => void openModelsFolder(key));
      folderBtns.appendChild(b);
    }

    diffBox.append(diffHead, diffDesc, ckptGrp, wfGrp, summaryEl, folderBtns);
    wrap.appendChild(diffBox);

    bodyHost.replaceChildren(wrap);
  }

  function syncNodeSection() {
    if (!nodeStatusRefs || activeTab !== 'project' || closed) return;
    const conn = connectionStore.get();
    const outbox = outboxStore.get();
    nodeStatusRefs.badge.className = `status-badge ${conn.mode === 'online' ? 'status-online' : 'status-offline'}`;
    nodeStatusRefs.badge.textContent = conn.mode === 'online' ? 'Online' : (conn.mode === 'offline' ? 'Offline' : 'Dormant');
    nodeStatusRefs.statusLine.textContent = conn.mode === 'online'
      ? `${conn.nodeUrl} (${conn.gpuMode}${conn.activeModel ? `, ${conn.activeModel}` : ''})`
      : conn.mode === 'offline'
        ? (conn.error || 'Node unreachable.')
        : 'Dormant until configured or same-origin.';
    if (outbox.items.length > 0) {
      nodeStatusRefs.flushBtn.hidden = false;
      nodeStatusRefs.flushBtn.textContent = `Flush Outbox (${outbox.items.length})`;
    } else {
      nodeStatusRefs.flushBtn.hidden = true;
    }
  }

  function renderProjectTab() {
    nodeStatusRefs = null;
    const card = doc.createElement('div');
    card.className = 'form-card-container';

    // Folders
    const foldersBlock = doc.createElement('div');
    const fh = doc.createElement('h4');
    fh.className = 'modal-sub-header';
    fh.textContent = 'Folders';
    const foldersList = doc.createElement('div');
    foldersList.className = 'classic-cards-stack';

    const saveCurrent = async () => {
      await patchProjectSettings({ folders: projectSettings.folders }, { rerender: true });
    };

    (projectSettings.folders || []).forEach((folder, idx) => {
      const row = doc.createElement('div');
      row.className = 'list-entry-row row-layout';
      row.style.fontFamily = 'monospace';
      const pathSpan = doc.createElement('span');
      pathSpan.textContent = folder;
      pathSpan.style.overflow = 'hidden';
      pathSpan.style.textOverflow = 'ellipsis';
      row.appendChild(pathSpan);

      if (idx === 0) {
        const defBadge = doc.createElement('span');
        defBadge.className = 'badge-default';
        defBadge.textContent = 'Default';
        row.appendChild(defBadge);
      } else {
        const setDefBtn = doc.createElement('button');
        setDefBtn.type = 'button';
        setDefBtn.className = 'edit-btn';
        setDefBtn.setAttribute('aria-label', `Set ${folder} as default folder`);
        setDefBtn.textContent = 'Set Default';
        setDefBtn.addEventListener('click', async () => {
          projectSettings.folders = [folder, ...(projectSettings.folders || []).filter((f) => f !== folder)];
          await saveCurrent();
        });
        row.appendChild(setDefBtn);
      }

      if (idx > 0 || (projectSettings.folders || []).length > 1) {
        const rmBtn = doc.createElement('button');
        rmBtn.type = 'button';
        rmBtn.className = 'action-icon-btn';
        rmBtn.setAttribute('aria-label', `Remove folder ${folder}`);
        rmBtn.textContent = '×';
        rmBtn.addEventListener('click', async () => {
          projectSettings.folders = (projectSettings.folders || []).filter((f) => f !== folder);
          await saveCurrent();
        });
        row.appendChild(rmBtn);
      }
      foldersList.appendChild(row);
    });

    const addFolderBtn = doc.createElement('button');
    addFolderBtn.type = 'button';
    addFolderBtn.className = 'dashed-action-btn';
    addFolderBtn.textContent = '+ Add Folder';
    addFolderBtn.addEventListener('click', async () => {
      const appendFolder = async (folderPath) => {
        const clean = String(folderPath || '').trim();
        if (!clean) return;
        const exists = (projectSettings.folders || []).some((f) => f.toLowerCase() === clean.toLowerCase());
        if (exists) {
          showAlert('Folder Exists', 'This folder is already in the workspace.');
          return;
        }
        projectSettings.folders = [...(projectSettings.folders || []), clean];
        await saveCurrent();
      };

      try {
        const res = await browseWorkspaceFolder();
        if (res?.folder) {
          await appendFolder(res.folder);
        }
      } catch {
        showPrompt('Add Workspace Folder', 'Enter full workspace folder path:', '', appendFolder);
      }
    });

    foldersBlock.append(fh, foldersList, addFolderBtn);

    // Program Settings
    const progBlock = doc.createElement('div');
    progBlock.className = 'classic-section-divider';
    const ph = doc.createElement('h4');
    ph.className = 'modal-sub-header';
    ph.textContent = 'Program Settings';

    const secRow = doc.createElement('div');
    secRow.className = 'classic-setting-row';
    const secInfo = doc.createElement('div');
    const secLbl = doc.createElement('label');
    secLbl.setAttribute('for', 'project-security-preset');
    secLbl.textContent = 'Security Preset';
    const secSub = doc.createElement('p');
    secSub.className = 'classic-card-subtext';
    secSub.textContent = 'Approval policy for shell commands and file edits.';
    secInfo.append(secLbl, secSub);

    const secSelect = doc.createElement('select');
    secSelect.id = 'project-security-preset';
    secSelect.className = 'onboarding-input glass-select';
    secSelect.style.width = '180px';
    const currentSec = normalizeSecurityPreset(projectSettings.security_preset);
    for (const [val, text] of [['ask_always', 'Always Ask'], ['auto', 'Auto']]) {
      const opt = doc.createElement('option');
      opt.value = val;
      opt.textContent = text;
      if (currentSec === val) opt.selected = true;
      secSelect.appendChild(opt);
    }
    secSelect.addEventListener('change', async () => {
      await patchProjectSettings({ security_preset: secSelect.value });
    });
    secRow.append(secInfo, secSelect);

    const revRow = doc.createElement('div');
    revRow.className = 'classic-setting-row';
    const revInfo = doc.createElement('div');
    const revLbl = doc.createElement('label');
    revLbl.setAttribute('for', 'project-review-policy');
    revLbl.textContent = 'Review Policy';
    const revSub = doc.createElement('p');
    revSub.className = 'classic-card-subtext';
    revSub.textContent = 'Approval policy for generated plans and documents.';
    revInfo.append(revLbl, revSub);

    const revSelect = doc.createElement('select');
    revSelect.id = 'project-review-policy';
    revSelect.className = 'onboarding-input glass-select';
    revSelect.style.width = '180px';
    const currentRev = projectSettings.artifact_review_policy || 'ask_always';
    for (const [val, text] of [['ask_always', 'Always Ask'], ['auto_approve', 'Auto']]) {
      const opt = doc.createElement('option');
      opt.value = val;
      opt.textContent = text;
      if (currentRev === val) opt.selected = true;
      revSelect.appendChild(opt);
    }
    revSelect.addEventListener('change', async () => {
      await patchProjectSettings({ artifact_review_policy: revSelect.value });
    });
    revRow.append(revInfo, revSelect);

    const makeSettingRow = (inputId, titleText, subText, controlEl, subId = '') => {
      const row = doc.createElement('div');
      row.className = 'classic-setting-row';
      const info = doc.createElement('div');
      const lbl = doc.createElement('label');
      if (inputId) lbl.setAttribute('for', inputId);
      lbl.textContent = titleText;
      const sub = doc.createElement('p');
      sub.className = 'classic-card-subtext';
      if (subId) sub.id = subId;
      sub.textContent = subText;
      info.append(lbl, sub);
      row.append(info, controlEl);
      return Object.assign(row, { _subEl: sub });
    };

    const makeTextInput = (id, { type = 'text', value = '', placeholder = '', list = '' } = {}) => {
      const inp = doc.createElement('input');
      inp.type = type;
      inp.id = id;
      inp.className = 'onboarding-input';
      inp.style.width = '200px';
      inp.placeholder = placeholder;
      inp.autocomplete = 'off';
      if (list) inp.setAttribute('list', list);
      inp.value = value;
      return inp;
    };

    const greenptKeyIn = makeTextInput('project-greenpt-api-key', {
      type: 'password',
      value: projectSettings.greenpt_api_key || '',
      placeholder: 'sk-...',
    });
    let keyDebounceTimer = null;
    const commitGreenptKey = async () => {
      if (keyDebounceTimer) {
        clearTimeout(keyDebounceTimer);
        keyDebounceTimer = null;
      }
      flushPendingKeySave = null;
      await patchProjectSettings({ greenpt_api_key: greenptKeyIn.value.trim() });
    };
    greenptKeyIn.addEventListener('input', () => {
      dirtyFields.add('greenpt_api_key');
      projectSettings.greenpt_api_key = greenptKeyIn.value.trim();
      if (keyDebounceTimer) clearTimeout(keyDebounceTimer);
      flushPendingKeySave = () => {
        void commitGreenptKey().catch(() => {});
      };
      keyDebounceTimer = setTimeout(() => {
        void commitGreenptKey().catch(() => {});
      }, 350);
    });
    greenptKeyIn.addEventListener('change', commitGreenptKey);
    const apiKeyRow = makeSettingRow(
      'project-greenpt-api-key',
      'Cloud API Key',
      'Bearer API key for OpenHands coding, cloud upscale, and web tools.',
      greenptKeyIn,
    );

    const endpointPresets = doc.createElement('datalist');
    endpointPresets.id = 'greenpt-endpoints-list';
    ['https://api.greenpt.ai/v1', 'https://api.us.greenpt.ai/v1', 'https://gateway.inference.coop/v1', 'https://api.regolo.ai/v1', 'https://inference.tinfoil.sh/v1'].forEach((u) => {
      const opt = doc.createElement('option');
      opt.value = u;
      endpointPresets.appendChild(opt);
    });

    const baseUrlIn = makeTextInput('project-greenpt-base-url', {
      value: projectSettings.greenpt_base_url || 'https://api.greenpt.ai/v1',
      placeholder: 'https://api.example.org/v1',
      list: 'greenpt-endpoints-list',
    });
    baseUrlIn.addEventListener('change', async () => {
      const nextUrl = baseUrlIn.value.trim() || 'https://api.greenpt.ai/v1';
      baseUrlIn.value = nextUrl;
      await patchProjectSettings({ greenpt_base_url: nextUrl });
    });
    const baseUrlWrap = doc.createElement('div');
    baseUrlWrap.append(baseUrlIn, endpointPresets);
    const baseUrlRow = makeSettingRow(
      'project-greenpt-base-url',
      'Cloud /v1 Endpoint',
      'Any OpenAI-compatible /v1 endpoint (e.g. a worker co-op or regional host).',
      baseUrlWrap,
    );

    const routingSelect = doc.createElement('select');
    routingSelect.id = 'project-routing-policy';
    routingSelect.className = 'onboarding-input glass-select';
    routingSelect.style.width = '210px';
    [
      ['auto', 'Auto Baton'],
      ['eco_flash', 'Eco Flash'],
      ['private_tee', 'Confidential TEE / ZDR'],
      ['local_only', 'Local Only (Air-Gapped)'],
    ].forEach(([val, label]) => {
      const opt = doc.createElement('option');
      opt.value = val;
      opt.textContent = label;
      routingSelect.appendChild(opt);
    });
    routingSelect.value = ['auto', 'eco_flash', 'private_tee', 'local_only'].includes(projectSettings.routing_policy)
      ? projectSettings.routing_policy
      : 'auto';
    routingSelect.addEventListener('change', async () => {
      await patchProjectSettings({ routing_policy: routingSelect.value });
    });
    const routingRow = makeSettingRow(
      'project-routing-policy',
      'Baton & Routing Policy',
      'Coordinate turns across your local GGUF model, cloud /v1 endpoint, and OpenHands.',
      routingSelect,
    );

    const modelList = doc.createElement('datalist');
    modelList.id = 'greenpt-models-list';
    [
      'glm-5.3', 'glm-5.3-flash', 'deepseek-v4.1-flash-1017', 'kimi-k3.1-pro', 'green-r', 'green-l',
      'glm-flash-green', 'deepseek-flash-green', 'glm-tee', 'deepseek-flash-tee',
      'greenpt/glm-5.3', 'regolo/apertus-70b', 'regolo/qwen3.5-122b', 'regolo/gemma4-31b',
    ].forEach((m) => {
      const opt = doc.createElement('option');
      opt.value = m;
      modelList.appendChild(opt);
    });

    const modelIn = makeTextInput('project-openhands-model', {
      value: projectSettings.openhands_model || 'glm-5.3',
      placeholder: 'glm-5.3',
      list: 'greenpt-models-list',
    });
    modelIn.addEventListener('change', async () => {
      const nextModel = modelIn.value.trim() || 'glm-5.3';
      modelIn.value = nextModel;
      await patchProjectSettings({ openhands_model: nextModel });
    });
    const modelWrap = doc.createElement('div');
    modelWrap.append(modelIn, modelList);
    const modelRow = makeSettingRow(
      'project-openhands-model',
      'OpenHands Coding Model',
      'Lead coding model (researcher and verifier subagents tier to flash when supported).',
      modelWrap,
    );

    const fastModelIn = makeTextInput('project-cloud-fast-model', {
      value: projectSettings.cloud_fast_model || '',
      placeholder: 'Auto from endpoint',
      list: 'greenpt-models-list',
    });
    fastModelIn.addEventListener('change', async () => {
      const nextVal = fastModelIn.value.trim();
      fastModelIn.value = nextVal;
      await patchProjectSettings({ cloud_fast_model: nextVal });
    });
    const fastModelRow = makeSettingRow(
      'project-cloud-fast-model',
      'Fast / Subagent Model',
      'Optional fast-tier override for cloud escalation and coding subagents (blank = auto).',
      fastModelIn,
    );

    const visionModelIn = makeTextInput('project-cloud-vision-model', {
      value: projectSettings.cloud_vision_model || '',
      placeholder: 'Auto from endpoint',
      list: 'greenpt-models-list',
    });
    visionModelIn.addEventListener('change', async () => {
      const nextVal = visionModelIn.value.trim();
      visionModelIn.value = nextVal;
      await patchProjectSettings({ cloud_vision_model: nextVal });
    });
    const visionModelRow = makeSettingRow(
      'project-cloud-vision-model',
      'Vision Model',
      'Optional multimodal vision override for image turns (blank = auto).',
      visionModelIn,
    );

    const ohModeSelect = doc.createElement('select');
    ohModeSelect.id = 'project-openhands-mode';
    ohModeSelect.className = 'onboarding-input';
    ohModeSelect.style.width = '200px';
    [
      ['auto', 'Auto (Warm Server or CLI)'],
      ['cli', 'Headless CLI Subprocess'],
      ['server', 'OpenHands HTTP Server (/v1)'],
    ].forEach(([val, label]) => {
      const opt = doc.createElement('option');
      opt.value = val;
      opt.textContent = label;
      ohModeSelect.appendChild(opt);
    });
    ohModeSelect.value = ['auto', 'cli', 'server'].includes(projectSettings.openhands_mode)
      ? projectSettings.openhands_mode
      : 'auto';
    ohModeSelect.addEventListener('change', async () => {
      const nextMode = ['auto', 'cli', 'server'].includes(ohModeSelect.value)
        ? ohModeSelect.value
        : 'auto';
      await patchProjectSettings({ openhands_mode: nextMode });
    });
    const ohModeRow = makeSettingRow(
      'project-openhands-mode',
      'OpenHands Execution Mode',
      'Auto uses the warm /v1 server if running, otherwise an isolated headless CLI worker.',
      ohModeSelect,
    );

    const serverControls = doc.createElement('div');
    serverControls.style.display = 'flex';
    serverControls.style.alignItems = 'center';
    serverControls.style.gap = '8px';
    serverControls.style.flexWrap = 'wrap';
    serverControls.style.justifyContent = 'flex-end';

    const autoStartLbl = doc.createElement('label');
    autoStartLbl.style.display = 'inline-flex';
    autoStartLbl.style.alignItems = 'center';
    autoStartLbl.style.gap = '4px';
    autoStartLbl.style.fontSize = '12px';
    const autoStartChk = doc.createElement('input');
    autoStartChk.type = 'checkbox';
    autoStartChk.id = 'project-openhands-auto-start';
    autoStartChk.checked = Boolean(projectSettings.openhands_auto_start_server);
    autoStartChk.addEventListener('change', async () => {
      await patchProjectSettings({ openhands_auto_start_server: Boolean(autoStartChk.checked) });
    });
    const autoStartTxt = doc.createElement('span');
    autoStartTxt.textContent = 'Auto-start';
    autoStartLbl.append(autoStartChk, autoStartTxt);

    const serverToggleBtn = doc.createElement('button');
    serverToggleBtn.type = 'button';
    serverToggleBtn.id = 'openhands-server-toggle-btn';
    serverToggleBtn.className = 'pill-btn-subtle';

    const serverRow = makeSettingRow(
      'project-openhands-auto-start',
      'OpenHands HTTP Server (/v1)',
      '',
      serverControls,
      'openhands-server-status',
    );
    const serverSubEl = serverRow._subEl;

    const renderServerStatus = () => {
      const port = openHandsServerInfo?.port || projectSettings.openhands_server_port || 8091;
      const isRunning = Boolean(openHandsServerInfo?.running);
      const endpoint = openHandsServerInfo?.openai_base_url || `http://127.0.0.1:${port}/v1`;
      const modelId = openHandsServerInfo?.model_id || 'openhands_greenpt';
      serverSubEl.textContent = isRunning
        ? `Running · ${endpoint} (${modelId})`
        : `Stopped · port ${port}`;
      serverToggleBtn.textContent = isRunning ? 'Stop Server' : 'Start Server';
    };
    renderServerStatus();

    serverToggleBtn.addEventListener('click', async () => {
      const isRunning = Boolean(openHandsServerInfo?.running);
      serverToggleBtn.disabled = true;
      serverSubEl.textContent = isRunning ? 'Stopping server...' : 'Starting server...';
      try {
        const res = await controlOpenHandsServer(isRunning ? 'stop' : 'start');
        if (res && typeof res === 'object') openHandsServerInfo = res;
      } catch (err) {
        serverSubEl.textContent = `Error: ${err?.message || 'request failed'}`;
      } finally {
        serverToggleBtn.disabled = false;
        renderServerStatus();
      }
    });
    serverControls.append(autoStartLbl, serverToggleBtn);

    const advDetails = doc.createElement('details');
    advDetails.className = 'advanced-openhands-disclosure';
    advDetails.style.marginTop = '8px';
    const advSummary = doc.createElement('summary');
    advSummary.className = 'classic-card-subtext';
    advSummary.style.cssText = 'cursor: pointer; user-select: none; padding: 6px 0; font-weight: 500;';
    advSummary.textContent = 'Advanced OpenHands & Model Overrides';
    advDetails.append(advSummary, modelRow, fastModelRow, visionModelRow, ohModeRow, serverRow);

    progBlock.append(ph, secRow, revRow, apiKeyRow, baseUrlRow, routingRow, advDetails);

    // Search Settings
    const searchBlock = doc.createElement('div');
    searchBlock.className = 'classic-section-divider';
    const sh = doc.createElement('h4');
    sh.className = 'modal-sub-header';
    sh.textContent = 'Search Settings';

    const browserCfg = browserStore.get().searchConfig;
    const activeProvider = normalizeSearchEngineId(
      projectSettings.browser_search_engine || browserCfg.engine || ''
    );
    if (!projectSettings.browser_search_engine && activeProvider) {
      projectSettings.browser_search_engine = activeProvider;
    }
    if (!projectSettings.searxng_url && browserCfg.searxngUrl) {
      projectSettings.searxng_url = browserCfg.searxngUrl;
    }
    if (!projectSettings.browser_custom_search_url && browserCfg.customTemplate) {
      projectSettings.browser_custom_search_url = browserCfg.customTemplate;
    }

    const providerRow = doc.createElement('div');
    providerRow.className = 'classic-setting-row';
    const providerInfo = doc.createElement('div');
    const providerLbl = doc.createElement('label');
    providerLbl.setAttribute('for', 'project-browser-search-engine');
    providerLbl.textContent = 'Browser Search Engine';
    const providerSub = doc.createElement('p');
    providerSub.id = 'project-browser-search-engine-help';
    providerSub.className = 'classic-card-subtext';
    providerSub.textContent = 'Address-bar search engine for Sanctuary Browser (Program web_search uses your Cloud /v1 endpoint or local fallback).';
    providerInfo.append(providerLbl, providerSub);

    const providerSelect = doc.createElement('select');
    providerSelect.id = 'project-browser-search-engine';
    providerSelect.name = 'browser_search_engine';
    providerSelect.setAttribute('aria-describedby', providerSub.id);
    providerSelect.className = 'onboarding-input glass-select';
    providerSelect.style.width = '210px';
    const noneOpt = doc.createElement('option');
    noneOpt.value = '';
    noneOpt.textContent = 'None (Ask when needed)';
    if (!activeProvider) noneOpt.selected = true;
    providerSelect.appendChild(noneOpt);
    for (const eng of SEARCH_ENGINES) {
      const opt = doc.createElement('option');
      opt.value = eng.id;
      opt.textContent = eng.alias ? `${eng.label} (${eng.alias})` : eng.label;
      if (activeProvider === eng.id) opt.selected = true;
      providerSelect.appendChild(opt);
    }
    providerSelect.value = activeProvider || '';
    providerRow.append(providerInfo, providerSelect);

    const searxRow = doc.createElement('div');
    searxRow.className = 'classic-setting-row';
    searxRow.hidden = providerSelect.value !== 'searxng';
    const searxLbl = doc.createElement('label');
    searxLbl.setAttribute('for', 'project-searxng-url');
    searxLbl.textContent = 'SearXNG Instance URL';
    const searxIn = doc.createElement('input');
    searxIn.type = 'url';
    searxIn.id = 'project-searxng-url';
    searxIn.name = 'searxng_url';
    searxIn.setAttribute('autocorrect', 'off');
    searxIn.setAttribute('autocapitalize', 'none');
    searxIn.spellcheck = false;
    searxIn.className = 'onboarding-input';
    searxIn.style.width = '210px';
    searxIn.placeholder = 'https://searx.example.org';
    searxIn.value = projectSettings.searxng_url || '';
    searxRow.append(searxLbl, searxIn);

    const customRow = doc.createElement('div');
    customRow.className = 'classic-setting-row';
    customRow.hidden = providerSelect.value !== 'custom';
    const customLbl = doc.createElement('label');
    customLbl.setAttribute('for', 'project-browser-custom-search-url');
    customLbl.textContent = 'Custom Search Template (%s)';
    const customIn = doc.createElement('input');
    customIn.type = 'url';
    customIn.id = 'project-browser-custom-search-url';
    customIn.name = 'browser_custom_search_url';
    customIn.setAttribute('autocorrect', 'off');
    customIn.setAttribute('autocapitalize', 'none');
    customIn.spellcheck = false;
    customIn.className = 'onboarding-input';
    customIn.style.width = '210px';
    customIn.placeholder = 'https://example.org/search?q=%s';
    customIn.value = projectSettings.browser_custom_search_url || '';
    customRow.append(customLbl, customIn);

    const syncBrowserFromProject = () => {
      setSearchConfig(
        {
          engine: projectSettings.browser_search_engine || '',
          searxngUrl: projectSettings.searxng_url || '',
          customTemplate: projectSettings.browser_custom_search_url || '',
        },
        { syncRemote: false }
      );
    };

    providerSelect.addEventListener('change', async () => {
      projectSettings.browser_search_engine = providerSelect.value;
      searxRow.hidden = providerSelect.value !== 'searxng';
      customRow.hidden = providerSelect.value !== 'custom';
      syncBrowserFromProject();
      await patchProjectSettings({ browser_search_engine: providerSelect.value });
    });
    searxIn.addEventListener('change', async () => {
      const nextSearx = searxIn.value.trim();
      projectSettings.searxng_url = nextSearx;
      syncBrowserFromProject();
      await patchProjectSettings({ searxng_url: nextSearx });
    });
    customIn.addEventListener('change', async () => {
      const nextCustom = customIn.value.trim();
      projectSettings.browser_custom_search_url = nextCustom;
      syncBrowserFromProject();
      await patchProjectSettings({ browser_custom_search_url: nextCustom });
    });

    searchBlock.append(sh, providerRow, searxRow, customRow);

    // Sanctuary Node Connection
    const conn = connectionStore.get();
    const outbox = outboxStore.get();
    const nodeBlock = doc.createElement('div');
    nodeBlock.className = 'classic-section-divider';

    const nodeHead = doc.createElement('div');
    nodeHead.className = 'option-header';
    const nh = doc.createElement('h4');
    nh.className = 'modal-sub-header';
    nh.style.marginBlockEnd = '0';
    nh.textContent = 'Sanctuary Node';
    const badge = doc.createElement('span');
    badge.className = `status-badge ${conn.mode === 'online' ? 'status-online' : 'status-offline'}`;
    badge.textContent = conn.mode === 'online' ? 'Online' : (conn.mode === 'offline' ? 'Offline' : 'Dormant');
    nodeHead.append(nh, badge);

    const statusLine = doc.createElement('p');
    statusLine.className = 'classic-card-subtext';

    const urlGrp = doc.createElement('div');
    urlGrp.className = 'input-group';
    const urlLbl = doc.createElement('label');
    urlLbl.setAttribute('for', 'node-url-input');
    urlLbl.textContent = 'Node URL (HTTPS, Tailscale, or localhost)';
    const urlIn = doc.createElement('input');
    urlIn.type = 'text';
    urlIn.id = 'node-url-input';
    urlIn.className = 'onboarding-input';
    urlIn.value = conn.nodeUrl || '';
    urlIn.placeholder = 'http://100.64.0.10:5000';
    urlIn.setAttribute('autocorrect', 'off');
    urlIn.setAttribute('autocapitalize', 'none');
    urlIn.setAttribute('spellcheck', 'false');
    urlGrp.append(urlLbl, urlIn);
    const transportNote = doc.createElement('p');
    transportNote.className = 'classic-card-subtext';
    transportNote.textContent = 'Use HTTPS for LAN access. HTTP is allowed on localhost or through Tailscale. Social accounts sync from the server without an app credential; Tailscale HTTP browsers keep tokens in memory and reload them from the server vault.';

    const authGrid = doc.createElement('div');
    authGrid.className = 'classic-two-col';
    const userGrp = doc.createElement('div');
    userGrp.className = 'input-group';
    const uLbl = doc.createElement('label');
    uLbl.setAttribute('for', 'node-auth-user');
    uLbl.textContent = 'Basic Auth User';
    const uIn = doc.createElement('input');
    uIn.type = 'text';
    uIn.id = 'node-auth-user';
    uIn.className = 'onboarding-input';
    uIn.setAttribute('autocorrect', 'off');
    uIn.setAttribute('autocapitalize', 'none');
    uIn.setAttribute('spellcheck', 'false');
    userGrp.append(uLbl, uIn);

    const passGrp = doc.createElement('div');
    passGrp.className = 'input-group';
    const pLbl = doc.createElement('label');
    pLbl.setAttribute('for', 'node-auth-pass');
    pLbl.textContent = 'Basic Auth Password';
    const pIn = doc.createElement('input');
    pIn.type = 'password';
    pIn.id = 'node-auth-pass';
    pIn.className = 'onboarding-input';
    passGrp.append(pLbl, pIn);
    authGrid.append(userGrp, passGrp);

    const nodeActions = doc.createElement('div');
    nodeActions.className = 'classic-card-actions';

    const testBtn = doc.createElement('button');
    testBtn.type = 'button';
    testBtn.className = 'btn-sleek-pill';
    testBtn.textContent = 'Connect & Test';
    testBtn.addEventListener('click', async () => {
      testBtn.disabled = true;
      try {
        await setSanctuaryNodeUrl(urlIn.value.trim());
        if (uIn.value.trim() || pIn.value) {
          await setSanctuaryBasicAuth(uIn.value.trim(), pIn.value);
        }
        await checkSanctuaryHealth();
        await loadNodeData();
        syncNodeSection();
      } catch (err) {
        showAlert('Node Error', err?.message || 'Invalid Sanctuary URL.');
      } finally {
        testBtn.disabled = false;
      }
    });

    const discBtn = doc.createElement('button');
    discBtn.type = 'button';
    discBtn.className = 'edit-btn edit-cancel-btn';
    discBtn.textContent = 'Disconnect';
    discBtn.addEventListener('click', async () => {
      await setSanctuaryBasicAuth('', '');
      await setSanctuaryNodeUrl('');
      urlIn.value = '';
      syncNodeSection();
    });

    const flushBtn = doc.createElement('button');
    flushBtn.type = 'button';
    flushBtn.className = 'onboarding-btn';
    flushBtn.hidden = outbox.items.length === 0;
    flushBtn.addEventListener('click', async () => {
      const res = await flushOutbox();
      showAlert('Outbox', `Flushed ${res.flushedCount} turn(s), ${res.remainingCount} remaining.`);
      syncNodeSection();
    });

    nodeActions.append(testBtn, discBtn, flushBtn);
    nodeBlock.append(nodeHead, statusLine, urlGrp, transportNote, authGrid, nodeActions);

    card.append(foldersBlock, progBlock, searchBlock, nodeBlock);
    nodeStatusRefs = { badge, statusLine, flushBtn };
    syncNodeSection();
    bodyHost.replaceChildren(card);
  }

  let modTabEpoch = 0;

  async function renderModerationTab() {
    nodeStatusRefs = null;
    const epoch = ++modTabEpoch;
    const card = doc.createElement('div');
    card.className = 'form-card-container';
    bodyHost.replaceChildren(card);

    // 1. Keyword Filters (mount form immediately & pre-populate from feedStore)
    const filterBlock = doc.createElement('div');
    const fh = doc.createElement('h4');
    fh.className = 'modal-sub-header';
    fh.textContent = 'Keyword Filters';
    const fSub = doc.createElement('p');
    fSub.className = 'classic-card-subtext';
    fSub.textContent = 'Hide or warn on matching posts across timelines.';

    const addForm = doc.createElement('form');
    addForm.className = 'list-create-row moderation-filter-form';
    const phraseLbl = doc.createElement('label');
    phraseLbl.setAttribute('for', 'moderation-filter-phrase');
    phraseLbl.className = 'visually-hidden';
    phraseLbl.textContent = 'Keyword or phrase';
    const phraseIn = doc.createElement('input');
    phraseIn.type = 'text';
    phraseIn.id = 'moderation-filter-phrase';
    phraseIn.name = 'phrase';
    phraseIn.className = 'onboarding-input';
    phraseIn.placeholder = 'Keyword or phrase...';
    phraseIn.setAttribute('autocorrect', 'off');
    phraseIn.setAttribute('autocapitalize', 'none');
    phraseIn.setAttribute('spellcheck', 'false');
    phraseIn.setAttribute('enterkeyhint', 'done');
    const actSelect = doc.createElement('select');
    actSelect.id = 'moderation-filter-action';
    actSelect.name = 'filter_action';
    actSelect.className = 'onboarding-input glass-select moderation-filter-action';
    for (const [val, lbl] of [['hide', 'Hide'], ['warn', 'Warn']]) {
      const opt = doc.createElement('option');
      opt.value = val;
      opt.textContent = lbl;
      actSelect.appendChild(opt);
    }
    const addFilterBtn = doc.createElement('button');
    addFilterBtn.type = 'submit';
    addFilterBtn.className = 'btn-sleek-pill';
    addFilterBtn.textContent = '+ Filter';
    addForm.append(phraseLbl, phraseIn, actSelect, addFilterBtn);

    const filtersWrap = doc.createElement('div');
    filtersWrap.className = 'moderation-filter-chips';

    const renderFilterChips = (rules = [], { loading = false } = {}) => {
      filtersWrap.replaceChildren();
      if (loading && rules.length === 0) {
        filtersWrap.appendChild(createLoadingState('Loading keyword filters…', { doc, compact: true }));
        return;
      }
      if (rules.length === 0) {
        const p = doc.createElement('p');
        p.className = 'classic-card-subtext';
        p.textContent = 'No keyword filters active.';
        filtersWrap.appendChild(p);
        return;
      }
      for (const f of rules) {
        const kws = Array.isArray(f.keywords) ? f.keywords.filter(Boolean) : [];
        const phrase = kws.length > 1
          ? (f.title && !kws.includes(f.title) ? `${f.title}: ${kws.join(', ')}` : kws.join(', '))
          : (f.phrase || kws[0] || f.title || '');
        const mode = String(f.filter_action || 'hide').toLowerCase();
        const chip = doc.createElement('div');
        chip.className = 'moderation-filter-chip';
        chip.dataset.filterAction = mode;

        const lbl = doc.createElement('span');
        lbl.className = 'moderation-filter-chip-label';
        lbl.textContent = phrase;
        chip.appendChild(lbl);

        if (mode !== 'hide') {
          const modeEl = doc.createElement('span');
          modeEl.className = 'moderation-filter-chip-mode';
          modeEl.textContent = mode;
          chip.appendChild(modeEl);
        }

        const delBtn = doc.createElement('button');
        delBtn.type = 'button';
        delBtn.className = 'moderation-filter-chip-remove';
        delBtn.setAttribute('aria-label', `Remove filter ${phrase}`);
        delBtn.textContent = '×';
        delBtn.addEventListener('click', async () => {
          delBtn.disabled = true;
          try {
            await removeKeywordFilter(f.id);
            if (!closed && activeTab === 'moderation' && epoch === modTabEpoch) {
              renderFilterChips(feedStore.get().filters || []);
            }
          } catch (err) {
            delBtn.disabled = false;
            showAlert('Filter Error', err?.message || 'Unable to remove filter.');
          }
        });
        chip.appendChild(delBtn);
        filtersWrap.appendChild(chip);
      }
    };

    addForm.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const phrase = phraseIn.value.trim();
      if (!phrase) return;
      addFilterBtn.disabled = true;
      try {
        await addKeywordFilter({ title: phrase, phrase, filterAction: actSelect.value });
        phraseIn.value = '';
        if (!closed && activeTab === 'moderation' && epoch === modTabEpoch) {
          renderFilterChips(feedStore.get().filters || []);
        }
      } catch (err) {
        showAlert('Filter Error', err?.message || 'Unable to add filter.');
      } finally {
        addFilterBtn.disabled = false;
      }
    });

    const cachedFilters = feedStore.get().filters || [];
    renderFilterChips(cachedFilters, { loading: cachedFilters.length === 0 });
    filterBlock.append(fh, fSub, addForm, filtersWrap);

    // 2. Public Discovery Toggle (Mastodon discoverable/indexable + Bluesky logged-out visibility)
    const publicBlock = doc.createElement('div');
    publicBlock.className = 'classic-section-divider';
    const ph = doc.createElement('h4');
    ph.className = 'modal-sub-header';
    ph.style.marginBlockEnd = '6px';
    ph.textContent = 'Public Discovery';

    const accounts = authStore.get().accounts || [];
    const hasConnectedSocial = accounts.some(
      (a) => a && (a.platform === 'fediverse' || a.platform === 'mastodon' || a.platform === 'bluesky')
    );

    const pubLabel = doc.createElement('label');
    pubLabel.className = `switch-container${hasConnectedSocial ? '' : ' is-disabled'}`;
    pubLabel.setAttribute('for', 'settings-public-discovery-toggle');

    const pubTextCol = doc.createElement('div');
    pubTextCol.className = 'switch-label-group';
    const pubTitle = doc.createElement('span');
    pubTitle.className = 'switch-title';
    pubTitle.textContent = 'Public Commons Visibility';
    const pubSub = doc.createElement('span');
    pubSub.className = 'switch-subtitle';
    pubSub.textContent = hasConnectedSocial
      ? 'Make your public posts discoverable across unmediated Mastodon & Bluesky streams and search.'
      : 'Connect Mastodon or Bluesky in Accounts to toggle public discovery.';
    pubTextCol.append(pubTitle, pubSub);

    const publicInput = doc.createElement('input');
    publicInput.type = 'checkbox';
    publicInput.id = 'settings-public-discovery-toggle';
    publicInput.className = 'switch-input';
    publicInput.setAttribute('switch', '');
    const hasNativeSwitch = typeof globalThis.HTMLInputElement?.prototype === 'object'
      && 'switch' in globalThis.HTMLInputElement.prototype;
    if (!hasNativeSwitch) publicInput.setAttribute('role', 'switch');
    publicInput.disabled = !hasConnectedSocial;
    publicInput.checked = isUnifiedPublicDiscoveryEnabled(accounts);

    const pubTrack = doc.createElement('span');
    pubTrack.className = 'switch-track';
    pubTrack.setAttribute('aria-hidden', 'true');
    const pubThumb = doc.createElement('span');
    pubThumb.className = 'switch-thumb';
    pubTrack.appendChild(pubThumb);
    pubLabel.append(pubTextCol, publicInput, pubTrack);

    const pubStatus = doc.createElement('p');
    pubStatus.className = 'classic-card-subtext public-discovery-status';
    pubStatus.setAttribute('role', 'status');
    pubStatus.setAttribute('aria-live', 'polite');
    pubStatus.hidden = true;

    publicInput.addEventListener('change', async () => {
      const desired = publicInput.checked;
      publicInput.disabled = true;
      pubLabel.classList.add('is-disabled');
      pubStatus.hidden = false;
      pubStatus.textContent = 'Updating public discovery…';
      try {
        await setUnifiedPublicDiscovery(desired);
        if (!closed && activeTab === 'moderation' && epoch === modTabEpoch) {
          pubStatus.textContent = desired
            ? 'Public discovery enabled across connected accounts.'
            : 'Public discovery turned off.';
        }
      } catch (err) {
        if (!closed && activeTab === 'moderation' && epoch === modTabEpoch) {
          publicInput.checked = !desired;
          pubStatus.textContent = formatApiErrorMessage(err?.message, 'Unable to update public discovery.');
        }
      } finally {
        if (!closed && activeTab === 'moderation' && epoch === modTabEpoch) {
          publicInput.disabled = !hasConnectedSocial;
          pubLabel.classList.toggle('is-disabled', !hasConnectedSocial);
        }
      }
    });

    publicBlock.append(ph, pubLabel, pubStatus);

    // 3. Feed Algorithm (interactive immediately at 0ms)
    const algoBlock = doc.createElement('div');
    algoBlock.className = 'classic-section-divider';
    const algoRow = doc.createElement('div');
    algoRow.className = 'classic-setting-row';
    const algoInfo = doc.createElement('div');
    const ah = doc.createElement('h4');
    ah.className = 'modal-sub-header';
    ah.style.marginBlockEnd = '2px';
    ah.textContent = 'Feed Algorithm';
    const aSub = doc.createElement('p');
    aSub.className = 'classic-card-subtext';
    aSub.textContent = 'Adjust local ranking weights and concept filters.';
    algoInfo.append(ah, aSub);
    const tuneBtn = doc.createElement('button');
    tuneBtn.type = 'button';
    tuneBtn.className = 'btn-sleek-pill';
    tuneBtn.textContent = 'Tune Feed...';
    tuneBtn.addEventListener('click', () => {
      openFeedTuningModal();
    });
    algoRow.append(algoInfo, tuneBtn);
    algoBlock.appendChild(algoRow);

    // 3. Muted & Blocked Account Sections (independent loading + in-place unmute/unblock)
    const buildModAccountSection = (title, emptyText, initialItems, btnLabel, actionFn, { loading = false } = {}) => {
      let items = Array.isArray(initialItems) ? [...initialItems] : [];
      const section = doc.createElement('div');
      section.className = 'classic-section-divider';
      const h = doc.createElement('h4');
      h.className = 'modal-sub-header';
      section.appendChild(h);

      const contentHost = doc.createElement('div');
      section.appendChild(contentHost);

      const renderSectionBody = () => {
        h.textContent = items.length > 0 ? `${title} (${items.length})` : title;
        contentHost.replaceChildren();
        if (loading && items.length === 0) {
          contentHost.appendChild(createLoadingState(`Loading ${title.toLowerCase()}…`, { doc, compact: true }));
          return;
        }
        if (items.length === 0) {
          const p = doc.createElement('p');
          p.className = 'classic-card-subtext';
          p.textContent = emptyText;
          contentHost.appendChild(p);
          return;
        }

        let filterQuery = '';
        let visibleLimit = 50;
        const stack = doc.createElement('div');
        stack.className = 'classic-cards-stack';
        const moreBtn = doc.createElement('button');
        moreBtn.type = 'button';
        moreBtn.className = 'edit-btn edit-cancel-btn';
        moreBtn.hidden = true;

        const renderRows = () => {
          const q = filterQuery.trim().toLowerCase();
          const filtered = q
            ? items.filter((acc) => {
                const txt = `${acc.displayName || ''} ${acc.username || ''} ${acc.acct || ''}`.toLowerCase();
                return txt.includes(q);
              })
            : items;
          const slice = filtered.slice(0, visibleLimit);
          stack.replaceChildren();
          for (const acc of slice) {
            const row = doc.createElement('div');
            row.className = 'moderation-account-row';

            const avatar = doc.createElement('img');
            avatar.className = 'moderation-account-avatar';
            avatar.src = acc.avatar || DEFAULT_AVATAR_DATA_URI;
            avatar.alt = '';
            avatar.loading = 'lazy';

            const info = doc.createElement('div');
            info.className = 'moderation-account-info';
            const nameEl = doc.createElement('span');
            nameEl.className = 'moderation-account-name';
            nameEl.textContent = acc.displayName || acc.username || acc.acct || '';
            const cleanAcct = String(acc.acct || acc.username || '').replace(/^@/, '');
            info.appendChild(nameEl);
            if (cleanAcct) {
              const handleEl = doc.createElement('span');
              handleEl.className = 'moderation-account-handle';
              handleEl.textContent = `@${cleanAcct}`;
              info.appendChild(handleEl);
            }

            const badgeEl = doc.createElement('span');
            badgeEl.className = 'post-protocol-badge';
            badgeEl.textContent = acc.protocol === 'threads'
              ? 'Threads'
              : (acc.protocol === 'bluesky' ? 'Bluesky' : 'Mastodon');

            const btn = doc.createElement('button');
            btn.type = 'button';
            btn.className = 'edit-btn moderation-unaction-btn';
            btn.textContent = btnLabel;
            btn.addEventListener('click', async () => {
              btn.disabled = true;
              try {
                await actionFn(acc);
                items = items.filter((entry) => entry !== acc);
                if (!closed && activeTab === 'moderation' && epoch === modTabEpoch) {
                  h.textContent = items.length > 0 ? `${title} (${items.length})` : title;
                  if (items.length === 0) renderSectionBody();
                  else renderRows();
                }
              } catch (err) {
                btn.disabled = false;
                showAlert('Moderation Error', err?.message || `Unable to ${btnLabel.toLowerCase()} account.`);
              }
            });
            row.append(avatar, info, badgeEl, btn);
            stack.appendChild(row);
          }
          const rem = filtered.length - slice.length;
          moreBtn.hidden = rem <= 0;
          if (rem > 0) {
            moreBtn.textContent = `Show ${Math.min(rem, 100)} more (${rem} remaining)`;
          }
        };

        if (items.length > 20) {
          const searchBox = doc.createElement('search');
          searchBox.className = 'moderation-account-search';
          const searchIn = doc.createElement('input');
          searchIn.type = 'search';
          searchIn.className = 'onboarding-input';
          searchIn.placeholder = `Filter ${title.toLowerCase()}...`;
          searchIn.setAttribute('aria-label', `Filter ${title}`);
          searchIn.setAttribute('autocorrect', 'off');
          searchIn.setAttribute('autocapitalize', 'none');
          searchIn.setAttribute('spellcheck', 'false');
          searchIn.addEventListener('input', () => {
            filterQuery = searchIn.value || '';
            visibleLimit = 50;
            renderRows();
          });
          searchBox.appendChild(searchIn);
          contentHost.appendChild(searchBox);
        }

        moreBtn.addEventListener('click', () => {
          visibleLimit += 100;
          renderRows();
        });

        renderRows();
        contentHost.append(stack, moreBtn);
      };

      renderSectionBody();
      return section;
    };

    const unmuteAccount = async (acc) => {
      await toggleMuteAuthor(acc.id || acc.acct || acc.username, true, {
        protocol: acc.protocol,
        acct: acc.acct || acc.username,
      });
      if (acc.localModeration) {
        await removeModeratedAccount('mutes', acc);
      }
    };
    const unblockAccount = async (acc) => {
      await toggleBlockAuthor(acc.id || acc.acct || acc.username, true, {
        protocol: acc.protocol,
        acct: acc.acct || acc.username,
        blockUri: acc.relationship?.blockUri || acc.viewer?.blocking || null,
      });
      if (acc.localModeration) {
        await removeModeratedAccount('blocks', acc);
      }
    };

    const cachedMutes = peekCachedModerationAccounts('mutes');
    const cachedBlocks = peekCachedModerationAccounts('blocks');

    const mutesHost = doc.createElement('div');
    mutesHost.appendChild(
      buildModAccountSection('Muted Accounts', 'No muted accounts.', cachedMutes || [], 'Unmute', unmuteAccount, {
        loading: cachedMutes === null,
      })
    );

    const blocksHost = doc.createElement('div');
    blocksHost.appendChild(
      buildModAccountSection('Blocked Accounts', 'No blocked accounts.', cachedBlocks || [], 'Unblock', unblockAccount, {
        loading: cachedBlocks === null,
      })
    );

    card.append(filterBlock, publicBlock, algoBlock, mutesHost, blocksHost);

    void fetchKeywordFilters()
      .then((freshFilters) => {
        if (closed || activeTab !== 'moderation' || epoch !== modTabEpoch) return;
        renderFilterChips(freshFilters || [], { loading: false });
      })
      .catch(() => {
        if (closed || activeTab !== 'moderation' || epoch !== modTabEpoch) return;
        renderFilterChips(feedStore.get().filters || [], { loading: false });
      });

    void fetchModerationAccounts('mutes')
      .then((mutes) => {
        if (closed || activeTab !== 'moderation' || epoch !== modTabEpoch) return;
        mutesHost.replaceChildren(
          buildModAccountSection('Muted Accounts', 'No muted accounts.', mutes, 'Unmute', unmuteAccount)
        );
      })
      .catch(() => {
        if (closed || activeTab !== 'moderation' || epoch !== modTabEpoch) return;
        mutesHost.replaceChildren(
          buildModAccountSection('Muted Accounts', 'No muted accounts.', cachedMutes || [], 'Unmute', unmuteAccount)
        );
      });

    void fetchModerationAccounts('blocks')
      .then((blocks) => {
        if (closed || activeTab !== 'moderation' || epoch !== modTabEpoch) return;
        blocksHost.replaceChildren(
          buildModAccountSection('Blocked Accounts', 'No blocked accounts.', blocks, 'Unblock', unblockAccount)
        );
      })
      .catch(() => {
        if (closed || activeTab !== 'moderation' || epoch !== modTabEpoch) return;
        blocksHost.replaceChildren(
          buildModAccountSection('Blocked Accounts', 'No blocked accounts.', cachedBlocks || [], 'Unblock', unblockAccount)
        );
      });
  }

  function renderBody() {
    if (closed) return;
    engineBtn.classList.toggle('active', activeTab === 'engine');
    projBtn.classList.toggle('active', activeTab === 'project');
    modBtn.classList.toggle('active', activeTab === 'moderation');
    descriptorEl.textContent = TAB_DESCRIPTORS[activeTab] || '';

    if (activeTab === 'engine') {
      nodeStatusRefs = null;
      renderModelsTab();
    } else if (activeTab === 'project') {
      renderProjectTab();
    } else {
      void renderModerationTab();
    }
  }

  async function loadNodeData() {
    if (connectionStore.get().mode !== 'online') return;
    try {
      const [nat, proj, ohSrv] = await Promise.all([
        Promise.resolve().then(() => fetchNativeModels()).catch(() => null),
        Promise.resolve().then(() => fetchProjectSettings()).catch(() => null),
        Promise.resolve().then(() => fetchOpenHandsServerStatus()).catch(() => null),
      ]);
      if (closed) return;
      if (nat) nativeInfo = nat;
      if (proj && !proj.error) {
        for (const [k, v] of Object.entries(proj)) {
          if (!dirtyFields.has(k)) projectSettings[k] = v;
        }
      }
      if (ohSrv && !ohSrv.error) openHandsServerInfo = ohSrv;
      renderBody();
    } catch {
      // Non-fatal in offline/dormant state
    }
  }

  engineBtn.addEventListener('click', () => {
    activeTab = 'engine';
    renderBody();
  });
  projBtn.addEventListener('click', () => {
    activeTab = 'project';
    renderBody();
  });
  modBtn.addEventListener('click', () => {
    activeTab = 'moderation';
    renderBody();
  });

  let prevConnMode = connectionStore.get().mode;
  const unsubConn = connectionStore.subscribe((st) => {
    syncNodeSection();
    if (st.mode !== prevConnMode) {
      prevConnMode = st.mode;
      if (st.mode === 'online') {
        void loadNodeData();
      } else if (activeTab === 'engine') {
        renderBody();
      }
    }
  });
  const unsubOut = outboxStore.subscribe(() => {
    syncNodeSection();
  });

  renderBody();
  void loadNodeData();
  modal.open();
  return modal;
}
