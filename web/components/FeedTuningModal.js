import {
  FEED_TUNING_PRESETS,
  SLIDER_DEFINITIONS,
  SLIDER_SPECS,
  isDefaultFeedTuning,
  normalizeFeedTuning,
} from '../core/feedRanker.js';
import { clearLearnedTasteMemory, feedStore, updateFeedTuning } from '../state/feedStore.js';
import { createClassicModalDialog } from './sanctuary/SanctuaryDialog.js';

const TUNE_MODAL_SVG = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--primary-accent)" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="4" y1="6" x2="20" y2="6"></line><circle cx="9" cy="6" r="2.2" fill="var(--bg-color, #121214)"></circle><line x1="4" y1="12" x2="20" y2="12"></line><circle cx="15" cy="12" r="2.2" fill="var(--bg-color, #121214)"></circle><line x1="4" y1="18" x2="20" y2="18"></line><circle cx="8" cy="18" r="2.2" fill="var(--bg-color, #121214)"></circle></svg>`;

function formatSliderReadout(def, val) {
  const spec = SLIDER_SPECS[def.key] || { min: -100, max: 100 };
  const n = Number(val) || 0;
  if (def.zeroLabel && n === 0) return def.zeroLabel;
  if (def.hideAtMin && n <= spec.min) return `${spec.min} (Hide)`;
  if (def.unit) return `${n}${def.unit}`;
  return n > 0 ? `+${n}` : String(n);
}

function syncSliderCssAndAria(input, outputEl, def, rawVal) {
  const spec = SLIDER_SPECS[def.key] || { min: -100, max: 100 };
  const formatted = formatSliderReadout(def, rawVal);
  input.value = String(rawVal);
  input.style?.setProperty?.('--attr-min', String(spec.min));
  input.style?.setProperty?.('--attr-max', String(spec.max));
  input.style?.setProperty?.('--control-value', String(rawVal));
  input.setAttribute('aria-valuetext', `${def.label}: ${formatted}`);
  if (outputEl) {
    outputEl.textContent = formatted;
    outputEl.dataset.tone = Number(rawVal) < 0 ? 'negative' : (Number(rawVal) > 0 ? 'positive' : 'neutral');
  }
}

function slidersMatchPreset(sliders, presetSliders) {
  for (const key of Object.keys(SLIDER_SPECS)) {
    if (Number(sliders?.[key] || 0) !== Number(presetSliders?.[key] || 0)) {
      return false;
    }
  }
  return true;
}

/**
 * Open the local feed algorithm & concept tuning modal.
 */
export function openFeedTuningModal() {
  const doc = globalThis.document;
  let closed = false;
  let saveTimer = null;
  let lastLocalEditAt = 0;

  const modal = createClassicModalDialog({
    id: 'feed-tuning-dialog',
    maxWidth: '580px',
    onClose: () => {
      closed = true;
      clearTimeout(saveTimer);
      unsubFeed();
      modal.dialog.remove();
    },
  });

  const heading = doc.createElement('h3');
  heading.id = modal.titleId;
  heading.className = 'classic-modal-title';
  heading.innerHTML = `${TUNE_MODAL_SVG}<span>Tune Feed Algorithm</span>`;

  const desc = doc.createElement('p');
  desc.className = 'classic-modal-desc';
  desc.textContent = 'Choose the public Fediverse communities and topic channels that expand the Feed, then tune ranking weights.';

  const scrollBody = doc.createElement('div');
  scrollBody.className = 'classic-modal-scroll-body';

  // Presets row
  const presetBar = doc.createElement('div');
  presetBar.className = 'feed-tuning-presets';
  const presetButtons = new Map();
  for (const preset of FEED_TUNING_PRESETS) {
    const btn = doc.createElement('button');
    btn.type = 'button';
    btn.className = 'btn-sleek-pill feed-preset-btn';
    btn.dataset.preset = preset.id;
    btn.textContent = preset.label;
    btn.addEventListener('click', () => {
      clearTimeout(saveTimer);
      lastLocalEditAt = Date.now();
      void updateFeedTuning(
        { sliders: preset.sliders },
        { updatedBy: preset.id === 'chronological' ? 'preset:chronological' : 'user' }
      );
    });
    presetButtons.set(preset.id, btn);
    presetBar.appendChild(btn);
  }
  scrollBody.appendChild(presetBar);

  function createChipListEditor({
    titleText,
    placeholder,
    btnLabel,
    inputId,
    datasetAttr,
    datasetVal,
    onAdd,
  }) {
    const wrap = doc.createElement('div');
    wrap.className = 'feed-concept-group';

    const lbl = doc.createElement('label');
    lbl.setAttribute('for', inputId);
    lbl.className = 'feed-concept-heading';
    lbl.textContent = titleText;

    const form = doc.createElement('form');
    form.className = 'list-create-row feed-concept-form';
    const input = doc.createElement('input');
    input.type = 'text';
    input.id = inputId;
    input.className = 'onboarding-input';
    input.placeholder = placeholder;
    const addBtn = doc.createElement('button');
    addBtn.type = 'submit';
    addBtn.className = 'btn-sleek-pill';
    addBtn.textContent = btnLabel;
    form.append(input, addBtn);

    const chipsWrap = doc.createElement('div');
    chipsWrap.className = 'moderation-filter-chips feed-concept-chips';
    chipsWrap.dataset[datasetAttr] = datasetVal;

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const raw = input.value.replace(/\s+/g, ' ').trim();
      if (!raw) return;
      input.value = '';
      lastLocalEditAt = Date.now();
      onAdd(raw);
    });

    wrap.append(lbl, form, chipsWrap);
    return { wrap, chipsWrap };
  }

  // Sovereign Discovery Sources (Channels & Instances)
  const sourcesSection = doc.createElement('div');
  sourcesSection.className = 'classic-section-divider feed-tuning-section';
  const srcHeading = doc.createElement('h4');
  srcHeading.className = 'modal-sub-header';
  srcHeading.textContent = 'Discovery Sources';
  const srcSub = doc.createElement('p');
  srcSub.className = 'classic-card-subtext';
  srcSub.textContent = 'Discovery channels are broad topic searches for hashtags and community feeds. Discovery sources are independent Fediverse and Lemmy communities whose public posts are fetched for the Feed.';

  const channelEditor = createChipListEditor({
    titleText: 'Topic Channels & ATProto Feeds',
    placeholder: 'e.g. news, technology, science...',
    btnLabel: '+ Channel',
    inputId: 'feed-channel-input',
    datasetAttr: 'sourceKind',
    datasetVal: 'channels',
    onAdd: (val) => {
      const cur = normalizeFeedTuning(feedStore.get().tuning);
      void updateFeedTuning({ discoveryChannels: [...cur.discoveryChannels, val] });
    },
  });

  const instanceEditor = createChipListEditor({
    titleText: 'Independent Instances',
    placeholder: 'e.g. mastodon.social, lemmy.world...',
    btnLabel: '+ Instance',
    inputId: 'feed-instance-input',
    datasetAttr: 'sourceKind',
    datasetVal: 'instances',
    onAdd: (val) => {
      const cur = normalizeFeedTuning(feedStore.get().tuning);
      void updateFeedTuning({ discoveryInstances: [...cur.discoveryInstances, val] });
    },
  });

  sourcesSection.append(srcHeading, srcSub, channelEditor.wrap, instanceEditor.wrap);
  scrollBody.appendChild(sourcesSection);

  // Grouped Sliders
  const sliderRefs = new Map();
  const groupOrder = ['Stream Structure', 'Format & Activity', 'Content Balances'];
  for (const groupTitle of groupOrder) {
    const defs = SLIDER_DEFINITIONS.filter((d) => d.group === groupTitle);
    if (defs.length === 0) continue;

    const section = doc.createElement('div');
    section.className = 'classic-section-divider feed-tuning-section';
    const sh = doc.createElement('h4');
    sh.className = 'modal-sub-header';
    sh.textContent = groupTitle;
    section.appendChild(sh);

    const stack = doc.createElement('div');
    stack.className = 'feed-tuning-slider-list';

    for (const def of defs) {
      const spec = SLIDER_SPECS[def.key];
      const row = doc.createElement('div');
      row.className = 'feed-tuning-row';

      const head = doc.createElement('div');
      head.className = 'feed-tuning-row-head';

      const label = doc.createElement('label');
      label.setAttribute('for', `feed-slider-${def.key}`);
      label.className = 'feed-tuning-label';
      label.textContent = def.label;

      const output = doc.createElement('output');
      output.id = `feed-output-${def.key}`;
      output.setAttribute('for', `feed-slider-${def.key}`);
      output.className = 'feed-tuning-value';

      head.append(label, output);

      const slider = doc.createElement('input');
      slider.type = 'range';
      slider.id = `feed-slider-${def.key}`;
      slider.dataset.sliderKey = def.key;
      slider.className = 'feed-tuning-slider';
      slider.min = String(spec.min);
      slider.max = String(spec.max);
      slider.step = String(spec.step);

      const help = doc.createElement('p');
      help.className = 'feed-tuning-help';
      help.textContent = def.description;

      const commitSliderValue = () => {
        clearTimeout(saveTimer);
        lastLocalEditAt = Date.now();
        const nextVal = Number(slider.value);
        void updateFeedTuning({ sliders: { [def.key]: nextVal } });
      };

      slider.addEventListener('input', () => {
        const nextVal = Number(slider.value);
        syncSliderCssAndAria(slider, output, def, nextVal);
        lastLocalEditAt = Date.now();
        const cur = normalizeFeedTuning(feedStore.get().tuning);
        const draftSliders = { ...cur.sliders };
        for (const [k, entry] of sliderRefs.entries()) {
          draftSliders[k] = Number(entry.slider.value);
        }
        for (const preset of FEED_TUNING_PRESETS) {
          const btn = presetButtons.get(preset.id);
          if (btn) btn.classList.toggle('is-active', slidersMatchPreset(draftSliders, preset.sliders));
        }
        clearTimeout(saveTimer);
        saveTimer = setTimeout(commitSliderValue, 180);
      });
      slider.addEventListener('change', commitSliderValue);

      sliderRefs.set(def.key, { def, slider, output });
      row.append(head, slider, help);
      stack.appendChild(row);
    }

    section.appendChild(stack);
    scrollBody.appendChild(section);
  }

  // Learned local personal taste memory section
  const tasteSection = doc.createElement('div');
  tasteSection.className = 'feed-tuning-concepts-section';
  const th = doc.createElement('h4');
  th.className = 'modal-sub-header';
  th.textContent = 'Learned Taste Memory';
  const tasteSummaryEl = doc.createElement('p');
  tasteSummaryEl.className = 'classic-card-subtext';
  const clearTasteBtn = doc.createElement('button');
  clearTasteBtn.type = 'button';
  clearTasteBtn.className = 'edit-btn';
  clearTasteBtn.textContent = 'Reset Learned Taste';
  clearTasteBtn.addEventListener('click', () => {
    void clearLearnedTasteMemory();
  });
  tasteSection.append(th, tasteSummaryEl, clearTasteBtn);
  scrollBody.appendChild(tasteSection);

  // Footer actions
  const footer = doc.createElement('div');
  footer.className = 'feed-tuning-footer';
  const resetBtn = doc.createElement('button');
  resetBtn.type = 'button';
  resetBtn.className = 'edit-btn';
  resetBtn.textContent = 'Reset All';
  resetBtn.addEventListener('click', () => {
    clearTimeout(saveTimer);
    lastLocalEditAt = Date.now();
    void updateFeedTuning({
      sliders: FEED_TUNING_PRESETS[0].sliders,
      discoveryChannels: [],
      discoveryInstances: [],
    });
  });

  const doneBtn = doc.createElement('button');
  doneBtn.type = 'button';
  doneBtn.className = 'btn-sleek-pill';
  doneBtn.textContent = 'Done';
  doneBtn.addEventListener('click', () => modal.close());
  footer.append(resetBtn, doneBtn);

  modal.card.append(heading, desc, scrollBody, footer);

  function renderChipList(chipsWrap, list, { emptyText, chipClass, ariaPrefix, onRemove }) {
    chipsWrap.replaceChildren();
    if (!Array.isArray(list) || list.length === 0) {
      const empty = doc.createElement('span');
      empty.className = 'classic-card-subtext';
      empty.textContent = emptyText;
      chipsWrap.appendChild(empty);
      return;
    }
    for (const entry of list) {
      const chip = doc.createElement('div');
      chip.className = `moderation-filter-chip feed-concept-chip ${chipClass}`;
      const lbl = doc.createElement('span');
      lbl.className = 'moderation-filter-chip-label';
      lbl.textContent = entry;
      const rmBtn = doc.createElement('button');
      rmBtn.type = 'button';
      rmBtn.className = 'moderation-filter-chip-remove';
      rmBtn.setAttribute('aria-label', `${ariaPrefix} ${entry}`);
      rmBtn.textContent = '×';
      rmBtn.addEventListener('click', () => {
        lastLocalEditAt = Date.now();
        onRemove(entry);
      });
      chip.append(lbl, rmBtn);
      chipsWrap.appendChild(chip);
    }
  }

  let lastChipSig = '';
  function syncFromStore() {
    if (closed) return;
    const tuning = normalizeFeedTuning(feedStore.get().tuning);
    for (const [key, { def, slider, output }] of sliderRefs.entries()) {
      const val = Number(tuning.sliders[key] || 0);
      if (Number(slider.value) !== val || slider.style.getPropertyValue('--control-value') !== String(val)) {
        syncSliderCssAndAria(slider, output, def, val);
      }
    }
    for (const preset of FEED_TUNING_PRESETS) {
      const btn = presetButtons.get(preset.id);
      if (btn) {
        btn.classList.toggle('is-active', slidersMatchPreset(tuning.sliders, preset.sliders));
      }
    }
    const st = feedStore.get();
    const posCount = Array.isArray(st.tasteMemory?.positive) ? st.tasteMemory.positive.length : 0;
    const negCount = Array.isArray(st.tasteMemory?.negative) ? st.tasteMemory.negative.length : 0;
    const impCount = st.implicitAuthors ? Object.keys(st.implicitAuthors).length : 0;
    tasteSummaryEl.textContent = `${posCount} liked/read · ${negCount} skipped/dismissed (stored locally)`;
    clearTasteBtn.disabled = posCount === 0 && negCount === 0 && impCount === 0;
    resetBtn.disabled = isDefaultFeedTuning(tuning);

    const nextSig = JSON.stringify([
      tuning.discoveryChannels,
      tuning.discoveryInstances,
    ]);
    if (nextSig !== lastChipSig) {
      lastChipSig = nextSig;
      renderChipList(channelEditor.chipsWrap, tuning.discoveryChannels, {
        emptyText: 'Defaults: news, technology, science, culture, music.',
        chipClass: 'feed-source-chip',
        ariaPrefix: 'Remove channel',
        onRemove: (entry) => {
          const cur = normalizeFeedTuning(feedStore.get().tuning);
          const low = entry.toLowerCase();
          void updateFeedTuning({ discoveryChannels: cur.discoveryChannels.filter((c) => c.toLowerCase() !== low) });
        },
      });
      renderChipList(instanceEditor.chipsWrap, tuning.discoveryInstances, {
        emptyText: 'Defaults: Mastodon and Lemmy servers.',
        chipClass: 'feed-source-chip',
        ariaPrefix: 'Remove instance',
        onRemove: (entry) => {
          const cur = normalizeFeedTuning(feedStore.get().tuning);
          const low = entry.toLowerCase();
          void updateFeedTuning({ discoveryInstances: cur.discoveryInstances.filter((c) => c.toLowerCase() !== low) });
        },
      });
    }
  }

  const unsubFeed = feedStore.subscribe(() => {
    // Allow immediate store reflections from external Program edits or own discrete clicks
    if (Date.now() - lastLocalEditAt < 40 && saveTimer) return;
    syncFromStore();
  });

  syncFromStore();
  modal.open();
  return modal;
}
