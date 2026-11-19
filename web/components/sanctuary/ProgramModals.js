import { applyRootProgramTheme } from '../../constants/theme.js';
import { bumpProgramAvatarVersion } from '../../state/sanctuary/connection.js';
import {
  createProgramFromDescription,
  fetchProgramProfile,
  fetchProgramTheme,
  importTavernCard,
  renameProgram,
  saveProgramProfile,
  selectProgram,
  updateProgramPalette,
} from '../../queries/sanctuary.js';
import {
  createClassicModalDialog,
  downloadNodeFile,
  isDavyActiveUser,
  showAlert,
} from './SanctuaryDialog.js';

const EDIT_SVG = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--primary-accent)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"></path><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path></svg>`;
const PALETTE_SVG = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--primary-accent)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 22C17.5228 22 22 17.5228 22 12C22 6.47715 17.5228 2 12 2C6.47715 2 2 6.47715 2 12C2 14.7255 3.09032 17.1962 4.85857 19C5.34776 19.4929 6.09675 19.3881 6.55163 18.88C7.11822 18.2467 7.90993 17.8462 8.79374 17.8462C10.5645 17.8462 12 19.2816 12 21.0524C12 21.5794 12 22 12 22Z"/><circle cx="7.5" cy="10.5" r="1.2" fill="currentColor"/><circle cx="11.5" cy="7.5" r="1.2" fill="currentColor"/><circle cx="16.5" cy="9.5" r="1.2" fill="currentColor"/><circle cx="15.5" cy="14.5" r="1.2" fill="currentColor"/></svg>`;
const CREATE_SVG = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--primary-accent)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path><circle cx="8.5" cy="7" r="4"></circle><line x1="20" y1="8" x2="20" y2="14"></line><line x1="23" y1="11" x2="17" y2="11"></line></svg>`;

const KOKORO_VOICES = [
  ['af_heart', 'af_heart (Default Female)'],
  ['af_bella', 'af_bella (Bella - Female)'],
  ['af_sarah', 'af_sarah (Sarah - Female)'],
  ['af_nicole', 'af_nicole (Nicole - Female)'],
  ['af_sky', 'af_sky (Sky - Female)'],
  ['am_adam', 'am_adam (Adam - Male)'],
  ['am_michael', 'am_michael (Michael - Male)'],
  ['am_fenrir', 'am_fenrir (Fenrir - Male)'],
  ['am_puck', 'am_puck (Puck - Male)'],
  ['bf_emma', 'bf_emma (Emma - Female UK)'],
  ['bf_isabella', 'bf_isabella (Isabella - Female UK)'],
  ['bm_george', 'bm_george (George - Male UK)'],
  ['bm_lewis', 'bm_lewis (Lewis - Male UK)'],
];

const PALETTE_PRESETS = [
  { name: 'Amethyst', hex: '#a855f7' },
  { name: 'Moonlit', hex: '#9370db' },
  { name: 'Rose Pink', hex: '#f43f5e' },
  { name: 'Emerald', hex: '#10b981' },
  { name: 'Amber', hex: '#f97316' },
  { name: 'Crimson', hex: '#ef4444' },
  { name: 'Yellow', hex: '#eab308' },
  { name: 'Pure White', hex: '#ffffff' },
];

/**
 * Classic Program Card Settings modal (chara_card_v3 fields + ComfyUI Image Prompts).
 */
export function openProgramCardModal({
  programId,
  activeUser = '',
  activeProgramId = '',
  onSaved,
} = {}) {
  if (programId === 'sebile' && !isDavyActiveUser(activeUser)) {
    showAlert('Protected Program', 'Sebile is a permanent core program and can only be edited by Davy.');
    return null;
  }

  const doc = globalThis.document;
  let currentProgramId = programId;
  let originalName = '';
  let activeTab = 'core';

  const modal = createClassicModalDialog({
    id: 'program-profile-dialog',
    maxWidth: '650px',
    onClose: () => modal.dialog.remove(),
  });

  const heading = doc.createElement('h3');
  heading.id = modal.titleId;
  heading.className = 'classic-modal-title';
  heading.innerHTML = `${EDIT_SVG}<span>Program Card Settings</span>`;

  const tabBar = doc.createElement('div');
  tabBar.className = 'classic-modal-tabs';
  const coreBtn = doc.createElement('button');
  coreBtn.type = 'button';
  coreBtn.className = 'modal-tab-btn active';
  coreBtn.textContent = 'Character';
  const physBtn = doc.createElement('button');
  physBtn.type = 'button';
  physBtn.className = 'modal-tab-btn';
  physBtn.textContent = 'Image Prompts';
  tabBar.append(coreBtn, physBtn);

  const corePanel = doc.createElement('div');
  corePanel.className = 'classic-modal-scroll-body';

  const physPanel = doc.createElement('div');
  physPanel.className = 'classic-modal-scroll-body';
  physPanel.hidden = true;

  // Row 1: Name + TTS Voice
  const row1 = doc.createElement('div');
  row1.className = 'classic-two-col';

  const nameGroup = doc.createElement('div');
  nameGroup.className = 'input-group';
  const nameLbl = doc.createElement('label');
  nameLbl.setAttribute('for', 'comp-name');
  nameLbl.textContent = 'Program Name';
  const nameInput = doc.createElement('input');
  nameInput.type = 'text';
  nameInput.id = 'comp-name';
  nameInput.className = 'onboarding-input';
  nameInput.placeholder = 'e.g. Sebile';
  nameGroup.append(nameLbl, nameInput);

  const voiceGroup = doc.createElement('div');
  voiceGroup.className = 'input-group';
  const voiceLbl = doc.createElement('label');
  voiceLbl.setAttribute('for', 'comp-tts-voice');
  voiceLbl.textContent = 'TTS Audio Voice';
  const voiceSelect = doc.createElement('select');
  voiceSelect.id = 'comp-tts-voice';
  voiceSelect.className = 'onboarding-input glass-select';
  for (const [val, lbl] of KOKORO_VOICES) {
    const opt = doc.createElement('option');
    opt.value = val;
    opt.textContent = lbl;
    voiceSelect.appendChild(opt);
  }
  voiceGroup.append(voiceLbl, voiceSelect);
  row1.append(nameGroup, voiceGroup);

  function addField(parent, { id, label, type = 'textarea', height = '60px', placeholder = '' }) {
    const grp = doc.createElement('div');
    grp.className = 'input-group';
    const lbl = doc.createElement('label');
    lbl.setAttribute('for', id);
    lbl.textContent = label;
    const ctrl = doc.createElement(type === 'input' ? 'input' : 'textarea');
    if (type === 'input') ctrl.type = 'text';
    ctrl.id = id;
    ctrl.className = 'onboarding-input';
    if (type === 'textarea') ctrl.style.height = height;
    if (placeholder) ctrl.placeholder = placeholder;
    grp.append(lbl, ctrl);
    parent.appendChild(grp);
    return ctrl;
  }

  corePanel.appendChild(row1);
  const persInput = addField(corePanel, {
    id: 'comp-personality-type',
    label: 'Personality',
    type: 'input',
    placeholder: 'e.g. Stoic, Loyal, Guarded',
  });
  const descTa = addField(corePanel, {
    id: 'comp-backstory',
    label: 'Description',
    height: '120px',
    placeholder: 'Who they are, their appearance, backstory, beliefs — written as prose. Use {{user}} and {{char}} as placeholders.',
  });
  const scenTa = addField(corePanel, {
    id: 'comp-scenario',
    label: 'Scenario',
    placeholder: 'A dark interior castle of the mind...',
  });
  const firstTa = addField(corePanel, {
    id: 'comp-example-msg',
    label: 'First Message',
    placeholder: '*I look up and smile.* Hello.',
  });
  const dirTa = addField(corePanel, {
    id: 'comp-directives',
    label: 'Response Instructions',
    placeholder: 'Speak naturally (use contractions). Be concise and direct.',
  });
  const postTa = addField(corePanel, {
    id: 'comp-post-history-instructions',
    label: 'Post-History Instructions',
    placeholder: 'Injected verbatim after the chat history on every turn. e.g. [Write concisely. Stay in character.]',
  });

  // Classic Story Mode switch
  const switchLbl = doc.createElement('label');
  switchLbl.className = 'switch-container';
  switchLbl.setAttribute('for', 'comp-story-mode');
  const switchTxt = doc.createElement('div');
  switchTxt.className = 'switch-label-group';
  const swTitle = doc.createElement('span');
  swTitle.className = 'switch-title';
  swTitle.textContent = 'Story Mode';
  const swSub = doc.createElement('span');
  swSub.className = 'switch-subtitle';
  swSub.textContent = 'Describe story around character instead of first-person chat';
  switchTxt.append(swTitle, swSub);

  const swTrackWrap = doc.createElement('div');
  swTrackWrap.style.position = 'relative';
  swTrackWrap.style.width = '36px';
  swTrackWrap.style.height = '20px';
  const storyCb = doc.createElement('input');
  storyCb.type = 'checkbox';
  storyCb.id = 'comp-story-mode';
  storyCb.className = 'switch-input';
  const swTrack = doc.createElement('div');
  swTrack.className = 'switch-track';
  const swThumb = doc.createElement('span');
  swThumb.className = 'switch-thumb';
  swTrack.appendChild(swThumb);
  swTrackWrap.append(storyCb, swTrack);
  switchLbl.append(switchTxt, swTrackWrap);
  corePanel.appendChild(switchLbl);

  // Image Prompts tab
  const physNote = doc.createElement('p');
  physNote.style.margin = '0 0 12px 0';
  physNote.textContent = 'These tags are used for image generation. They are not part of the character card.';
  physPanel.appendChild(physNote);
  const posTa = addField(physPanel, {
    id: 'comp-image-details',
    label: 'Positive Prompt Tags',
    height: '80px',
    placeholder: 'silver hair, purple eyes, fair skin, black robe...',
  });
  const negTa = addField(physPanel, {
    id: 'comp-negative-details',
    label: 'Negative Prompt Tags',
    height: '60px',
    placeholder: 'extra limbs, bad anatomy, deformed, mutated hands...',
  });

  const footer = doc.createElement('div');
  footer.className = 'classic-modal-footer-split';

  const exportBtn = doc.createElement('button');
  exportBtn.type = 'button';
  exportBtn.className = 'edit-btn edit-cancel-btn';
  exportBtn.textContent = 'Export Card';
  exportBtn.addEventListener('click', () => {
    const safeName = (nameInput.value.trim() || currentProgramId)
      .replace(/[^\w\- ]/g, '')
      .replace(/ /g, '_') || currentProgramId;
    void downloadNodeFile(`/api/programs/${encodeURIComponent(currentProgramId)}/export/card`, `${safeName}.json`);
  });

  const rightBtns = doc.createElement('div');
  rightBtns.className = 'classic-card-actions';

  const cancelBtn = doc.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'onboarding-btn';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', () => modal.close());

  const saveBtn = doc.createElement('button');
  saveBtn.type = 'button';
  saveBtn.className = 'onboarding-btn';
  saveBtn.textContent = 'Save Program Card';

  rightBtns.append(cancelBtn, saveBtn);
  footer.append(exportBtn, rightBtns);

  function switchTab(next) {
    activeTab = next;
    coreBtn.classList.toggle('active', next === 'core');
    physBtn.classList.toggle('active', next === 'phys');
    corePanel.hidden = next !== 'core';
    physPanel.hidden = next !== 'phys';
  }
  coreBtn.addEventListener('click', () => switchTab('core'));
  physBtn.addEventListener('click', () => switchTab('phys'));

  saveBtn.addEventListener('click', async () => {
    const newName = nameInput.value.trim();
    if (!newName) {
      showAlert('Error', 'Program Name cannot be empty.');
      return;
    }
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving...';
    try {
      let targetId = currentProgramId;
      let wasActive = false;
      if (newName !== originalName && currentProgramId !== 'sebile') {
        const ren = await renameProgram(currentProgramId, newName);
        if (ren?.new_id) targetId = ren.new_id;
        wasActive = Boolean(ren?.was_active);
      }

      const saved = await saveProgramProfile({
        program_id: targetId,
        name: newName,
        story_mode: storyCb.checked,
        tts_voice: voiceSelect.value,
        description: descTa.value.trim(),
        personality: persInput.value.trim(),
        scenario: scenTa.value.trim(),
        first_mes: firstTa.value.trim(),
        system_prompt: dirTa.value.trim(),
        post_history_instructions: postTa.value.trim(),
        extensions: {
          sanctuary: {
            program_id: targetId,
            image_details: {
              positive: posTa.value.trim(),
              negative: negTa.value.trim(),
            },
          },
        },
      });

      if (saved?.theme && (wasActive || currentProgramId === activeProgramId || targetId === activeProgramId)) {
        applyRootProgramTheme(saved.theme);
      }
      const prevId = currentProgramId;
      currentProgramId = targetId;
      originalName = newName;
      modal.close();
      await onSaved?.({ ...saved, previousProgramId: prevId, program_id: targetId, was_active: wasActive });
    } catch (err) {
      showAlert('Error', `Could not save program profile: ${err?.message || 'unknown error'}`);
    } finally {
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save Program Card';
    }
  });

  modal.card.append(heading, tabBar, corePanel, physPanel, footer);
  modal.open();

  void fetchProgramProfile(programId)
    .then((data) => {
      originalName = data?.name || programId;
      nameInput.value = originalName;
      persInput.value = data?.personality || '';
      descTa.value = data?.description || '';
      scenTa.value = data?.scenario || '';
      firstTa.value = data?.first_mes || '';
      dirTa.value = data?.system_prompt || '';
      postTa.value = data?.post_history_instructions || '';
      voiceSelect.value = data?.tts_voice || 'af_heart';
      storyCb.checked = Boolean(data?.story_mode);
      const imgDetails = data?.extensions?.sanctuary?.image_details || {};
      posTa.value = imgDetails.positive || '';
      negTa.value = imgDetails.negative || '';
    })
    .catch((err) => {
      showAlert('Error', `Could not load program profile: ${err?.message || 'unknown error'}`);
    });

  return modal;
}

/**
 * Classic Customize Program Theme modal with 8 preset swatches & hex color picker.
 */
export function openPaletteModal({
  programId,
  programName = programId,
  activeUser = '',
  activeProgramId = '',
  onUpdated,
} = {}) {
  if (programId === 'sebile' && !isDavyActiveUser(activeUser)) {
    showAlert('Protected Program', 'Sebile is a permanent core program and can only be edited by Davy.');
    return null;
  }

  const doc = globalThis.document;
  const modal = createClassicModalDialog({
    id: 'program-palette-dialog',
    maxWidth: '420px',
    onClose: () => modal.dialog.remove(),
  });

  const heading = doc.createElement('h3');
  heading.id = modal.titleId;
  heading.className = 'classic-modal-title';
  heading.innerHTML = `${PALETTE_SVG}<span>Customize Program Theme</span>`;

  const desc = doc.createElement('p');
  desc.textContent = `Select a preset color theme or custom hex color for ${programName}.`;

  const presetLbl = doc.createElement('label');
  presetLbl.textContent = 'Preset Themes';
  presetLbl.style.fontSize = '0.72rem';
  presetLbl.style.color = 'var(--text-muted)';
  presetLbl.style.display = 'block';
  presetLbl.style.marginBottom = '8px';

  const presetGrid = doc.createElement('div');
  presetGrid.className = 'classic-palette-grid';

  const colorPicker = doc.createElement('input');
  colorPicker.type = 'color';
  colorPicker.id = 'custom-palette-color-picker';
  colorPicker.className = 'classic-color-picker';
  colorPicker.value = '#9370db';

  const hexInput = doc.createElement('input');
  hexInput.type = 'text';
  hexInput.id = 'custom-palette-color-text';
  hexInput.className = 'onboarding-input';
  hexInput.style.textTransform = 'uppercase';
  hexInput.maxLength = 7;
  hexInput.placeholder = '#9370DB';
  hexInput.value = '#9370DB';

  const presetButtons = [];
  const selectColor = (hex) => {
    const clean = hex.startsWith('#') ? hex : `#${hex}`;
    colorPicker.value = clean;
    hexInput.value = clean.toUpperCase();
    for (const { btn, hex: pHex } of presetButtons) {
      btn.classList.toggle('is-selected', pHex.toLowerCase() === clean.toLowerCase());
    }
  };

  for (const preset of PALETTE_PRESETS) {
    const btn = doc.createElement('button');
    btn.type = 'button';
    btn.className = 'classic-swatch-btn';
    const dot = doc.createElement('span');
    dot.className = 'classic-swatch-dot';
    dot.style.backgroundColor = preset.hex;
    const lbl = doc.createElement('span');
    lbl.className = 'classic-swatch-label';
    lbl.textContent = preset.name;
    btn.append(dot, lbl);
    btn.addEventListener('click', () => selectColor(preset.hex));
    presetGrid.appendChild(btn);
    presetButtons.push({ btn, hex: preset.hex });
  }

  colorPicker.addEventListener('input', () => selectColor(colorPicker.value));
  hexInput.addEventListener('input', () => {
    let hex = hexInput.value.trim();
    if (hex && !hex.startsWith('#')) hex = `#${hex}`;
    if (/^#[0-9a-fA-F]{6}$/.test(hex)) {
      colorPicker.value = hex;
    }
  });

  const customGrp = doc.createElement('div');
  customGrp.className = 'input-group';
  const customLbl = doc.createElement('label');
  customLbl.setAttribute('for', 'custom-palette-color-text');
  customLbl.textContent = 'Custom Theme Color';
  const pickerRow = doc.createElement('div');
  pickerRow.className = 'classic-picker-row';
  pickerRow.append(colorPicker, hexInput);
  customGrp.append(customLbl, pickerRow);

  const footer = doc.createElement('div');
  footer.className = 'classic-modal-footer-end';
  const cancelBtn = doc.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'onboarding-btn';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', () => modal.close());

  const applyBtn = doc.createElement('button');
  applyBtn.type = 'button';
  applyBtn.className = 'onboarding-btn';
  applyBtn.textContent = 'Apply Theme';
  applyBtn.addEventListener('click', async () => {
    const color = hexInput.value.trim();
    if (!/^#[0-9a-fA-F]{6}$/.test(color)) {
      showAlert('Error', 'Please enter a valid hex color code (e.g. #9370DB).');
      return;
    }
    applyBtn.disabled = true;
    applyBtn.textContent = 'Applying...';
    try {
      const res = await updateProgramPalette(programId, color);
      if (res?.theme && (!activeProgramId || programId === activeProgramId)) {
        applyRootProgramTheme(res.theme);
      }
      modal.close();
      await onUpdated?.(res);
    } catch (err) {
      showAlert('Error', err?.message || 'Failed to save color palette.');
    } finally {
      applyBtn.disabled = false;
      applyBtn.textContent = 'Apply Theme';
    }
  });

  footer.append(cancelBtn, applyBtn);
  modal.card.append(heading, desc, presetLbl, presetGrid, customGrp, footer);
  modal.open();

  void fetchProgramTheme(programId)
    .then((tData) => {
      const current = tData?.theme?.primary_accent || '#9370db';
      selectColor(current);
    })
    .catch(() => {});

  return modal;
}

/**
 * Classic Create / Import Program modal supporting Character Card (.png / .json) or Text Description.
 */
export function openImportProgramModal({ onCreated } = {}) {
  const doc = globalThis.document;
  let activeTab = 'tavern';
  let selectedFile = null;

  const modal = createClassicModalDialog({
    id: 'import-program-dialog',
    maxWidth: '520px',
    onClose: () => modal.dialog.remove(),
  });

  const heading = doc.createElement('h3');
  heading.id = modal.titleId;
  heading.className = 'classic-modal-title';
  heading.innerHTML = `${CREATE_SVG}<span>Create / Import Program</span>`;

  const desc = doc.createElement('p');
  desc.textContent = 'Procedurally import a new program from a character card (PNG or JSON) or describe a new character persona using text.';

  const tabBar = doc.createElement('div');
  tabBar.className = 'classic-modal-tabs';
  const tavernBtn = doc.createElement('button');
  tavernBtn.type = 'button';
  tavernBtn.className = 'modal-tab-btn active';
  tavernBtn.textContent = 'Character Card';
  const descBtn = doc.createElement('button');
  descBtn.type = 'button';
  descBtn.className = 'modal-tab-btn';
  descBtn.textContent = 'Text Description';
  tabBar.append(tavernBtn, descBtn);

  // Tavern Card tab
  const tavernPanel = doc.createElement('div');
  const fileIn = doc.createElement('input');
  fileIn.type = 'file';
  fileIn.accept = 'image/png,.png,application/json,.json';
  fileIn.className = 'visually-hidden';
  fileIn.hidden = true;
  fileIn.id = 'import-tavern-file';

  const pickBtn = doc.createElement('button');
  pickBtn.type = 'button';
  pickBtn.className = 'dashed-action-btn';
  pickBtn.style.display = 'block';
  pickBtn.style.textAlign = 'center';
  pickBtn.style.marginBottom = '12px';
  pickBtn.textContent = '+ Select Card (PNG / JSON)';
  pickBtn.addEventListener('click', () => fileIn.click());

  fileIn.addEventListener('change', () => {
    selectedFile = fileIn.files?.[0] || null;
    if (selectedFile) {
      pickBtn.textContent = selectedFile.name;
      pickBtn.style.color = 'var(--primary-accent)';
    }
  });

  const impFooter = doc.createElement('div');
  impFooter.className = 'classic-modal-footer-end';
  const impBtn = doc.createElement('button');
  impBtn.type = 'button';
  impBtn.className = 'onboarding-btn';
  impBtn.textContent = 'Import Program';
  impBtn.addEventListener('click', async () => {
    if (!selectedFile) {
      showAlert('Error', 'Please select a character card (PNG or JSON) first.');
      return;
    }
    impBtn.disabled = true;
    impBtn.textContent = 'Importing...';
    try {
      const res = await importTavernCard(selectedFile);
      if (res?.program_id) {
        bumpProgramAvatarVersion(res.program_id);
        await selectProgram(res.program_id);
      }
      modal.close();
      await onCreated?.(res);
    } catch (err) {
      showAlert('Error', err?.message || 'Failed to import character card.');
    } finally {
      impBtn.disabled = false;
      impBtn.textContent = 'Import Program';
    }
  });
  impFooter.appendChild(impBtn);
  tavernPanel.append(fileIn, pickBtn, impFooter);

  // Text Description tab
  const descPanel = doc.createElement('div');
  descPanel.hidden = true;

  const pNameGroup = doc.createElement('div');
  pNameGroup.className = 'input-group';
  const pNameLbl = doc.createElement('label');
  pNameLbl.setAttribute('for', 'describe-program-name');
  pNameLbl.textContent = 'Program Name';
  const pNameIn = doc.createElement('input');
  pNameIn.type = 'text';
  pNameIn.id = 'describe-program-name';
  pNameIn.className = 'onboarding-input';
  pNameIn.placeholder = 'e.g. Marie the Librarian';
  pNameGroup.append(pNameLbl, pNameIn);

  const pDescGroup = doc.createElement('div');
  pDescGroup.className = 'input-group';
  const pDescLbl = doc.createElement('label');
  pDescLbl.setAttribute('for', 'describe-program-desc');
  pDescLbl.textContent = 'Character Persona Description';
  const pDescTa = doc.createElement('textarea');
  pDescTa.id = 'describe-program-desc';
  pDescTa.className = 'onboarding-input';
  pDescTa.style.height = '120px';
  pDescTa.placeholder = 'A calm, analytical archivist...';
  pDescGroup.append(pDescLbl, pDescTa);

  const genFooter = doc.createElement('div');
  genFooter.className = 'classic-modal-footer-end';
  const genBtn = doc.createElement('button');
  genBtn.type = 'button';
  genBtn.className = 'onboarding-btn';
  genBtn.textContent = 'Generate Program';
  genBtn.addEventListener('click', async () => {
    const name = pNameIn.value.trim();
    const description = pDescTa.value.trim();
    if (!name || !description) {
      showAlert('Error', 'Please provide a name and character description.');
      return;
    }
    genBtn.disabled = true;
    genBtn.textContent = 'Generating Persona...';
    try {
      const res = await createProgramFromDescription({ name, description });
      if (res?.program_id) await selectProgram(res.program_id);
      modal.close();
      await onCreated?.(res);
    } catch (err) {
      showAlert('Error', err?.message || 'Failed to generate program.');
    } finally {
      genBtn.disabled = false;
      genBtn.textContent = 'Generate Program';
    }
  });
  genFooter.appendChild(genBtn);
  descPanel.append(pNameGroup, pDescGroup, genFooter);

  function switchTab(next) {
    activeTab = next;
    tavernBtn.classList.toggle('active', next === 'tavern');
    descBtn.classList.toggle('active', next === 'describe');
    tavernPanel.hidden = next !== 'tavern';
    descPanel.hidden = next !== 'describe';
  }
  tavernBtn.addEventListener('click', () => switchTab('tavern'));
  descBtn.addEventListener('click', () => switchTab('describe'));

  modal.card.append(heading, desc, tabBar, tavernPanel, descPanel);
  modal.open();
  return modal;
}
