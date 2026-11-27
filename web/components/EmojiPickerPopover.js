import {
  SKIN_TONE_MODIFIERS,
  UNICODE_EMOJI_CATEGORIES,
  applySkinTone,
} from '../constants/unicodeEmojis.js';
import { kvGet, kvSet } from '../storage/nativeStore.js';

const SMILEY_SVG = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><path d="M8 14s1.5 2 4 2 4-2 4-2"></path><line x1="9" y1="9" x2="9.01" y2="9"></line><line x1="15" y1="9" x2="15.01" y2="9"></line></svg>`;

export const EMOJI_CATEGORIES = UNICODE_EMOJI_CATEGORIES;

const ALL_EMOJI_MAP = new Map();
for (const cat of EMOJI_CATEGORIES) {
  for (const [glyph, keywords] of cat.items) {
    if (!ALL_EMOJI_MAP.has(glyph)) {
      ALL_EMOJI_MAP.set(glyph, keywords);
    }
  }
}

const UNICODE_EMOJI_RE = /\p{Extended_Pictographic}/u;

/**
 * Zero-dependency native Unicode emoji picker popover tethered to an icon trigger button.
 */
export function createEmojiPicker({
  popoverId = 'compose-emoji-popover',
  onSelectEmoji,
} = {}) {
  const doc = globalThis.document;
  const recentStorageKey = 'recent_emojis';
  const toneStorageKey = 'emoji_skin_tone';
  let recentEmojis = [];
  let activeCatId = 'smileys';
  let searchQuery = '';
  let selectedTone = '';

  const triggerBtn = doc.createElement('button');
  triggerBtn.type = 'button';
  triggerBtn.className = 'compose-tool-icon-btn compose-emoji-btn';
  triggerBtn.setAttribute('aria-label', 'Add Emoji');
  triggerBtn.title = 'Add Emoji';
  triggerBtn.setAttribute('popovertarget', popoverId);
  triggerBtn.innerHTML = SMILEY_SVG;

  const panel = doc.createElement('div');
  panel.id = popoverId;
  panel.className = 'emoji-picker-popover';
  panel.setAttribute('popover', 'auto');

  const hasNativePopover = typeof panel.togglePopover === 'function';

  const topRow = doc.createElement('div');
  topRow.className = 'emoji-picker-top';

  const searchIn = doc.createElement('input');
  searchIn.type = 'search';
  searchIn.className = 'onboarding-input emoji-picker-search';
  searchIn.placeholder = 'Search emoji...';
  searchIn.setAttribute('aria-label', 'Search emoji');
  searchIn.setAttribute('autocomplete', 'off');
  searchIn.setAttribute('autocorrect', 'off');
  searchIn.setAttribute('autocapitalize', 'none');
  searchIn.setAttribute('spellcheck', 'false');

  const tonesBar = doc.createElement('div');
  tonesBar.className = 'emoji-picker-tones';
  tonesBar.setAttribute('role', 'group');
  tonesBar.setAttribute('aria-label', 'Skin tone');

  topRow.append(searchIn, tonesBar);

  const catsBar = doc.createElement('div');
  catsBar.className = 'emoji-picker-cats';

  const grid = doc.createElement('div');
  grid.className = 'emoji-picker-grid';

  panel.append(topRow, catsBar, grid);

  function setFallbackOpen(open) {
    panel.hidden = !open;
    panel.classList.toggle('is-fallback-open', Boolean(open));
  }

  function close() {
    if (hasNativePopover) {
      panel.hidePopover?.();
    } else {
      setFallbackOpen(false);
    }
  }

  function renderTones() {
    tonesBar.replaceChildren();
    for (const tone of SKIN_TONE_MODIFIERS) {
      const btn = doc.createElement('button');
      btn.type = 'button';
      btn.className = `emoji-picker-tone-btn${tone.id === selectedTone ? ' is-selected' : ''}`;
      btn.title = tone.label;
      btn.setAttribute('aria-label', tone.label);
      btn.setAttribute('aria-pressed', tone.id === selectedTone ? 'true' : 'false');
      btn.textContent = tone.preview;
      btn.addEventListener('click', () => {
        selectedTone = tone.id;
        void kvSet(toneStorageKey, selectedTone).catch(() => {});
        renderTones();
        renderGrid();
      });
      tonesBar.appendChild(btn);
    }
  }

  function renderGrid() {
    grid.replaceChildren();
    catsBar.replaceChildren();
    const cleanQ = searchQuery.trim().toLowerCase();
    catsBar.hidden = Boolean(cleanQ);

    if (!cleanQ) {
      const catTabs = recentEmojis.length > 0
        ? [{ id: 'recent', icon: '🕘', label: 'Recent' }, ...EMOJI_CATEGORIES]
        : EMOJI_CATEGORIES;
      if (!catTabs.some((c) => c.id === activeCatId)) {
        activeCatId = catTabs[0]?.id || 'smileys';
      }
      for (const cat of catTabs) {
        const b = doc.createElement('button');
        b.type = 'button';
        b.className = `emoji-picker-cat-btn${cat.id === activeCatId ? ' active' : ''}`;
        b.title = cat.label;
        b.setAttribute('aria-label', cat.label);
        b.textContent = cat.icon;
        b.addEventListener('click', () => {
          activeCatId = cat.id;
          renderGrid();
        });
        catsBar.appendChild(b);
      }
    }

    let entries = [];
    if (cleanQ) {
      const tokens = cleanQ.split(/\s+/).filter(Boolean);
      for (const [glyph, kw] of ALL_EMOJI_MAP.entries()) {
        const toned = applySkinTone(glyph, selectedTone);
        const matchesAll = tokens.every((tok) => kw.includes(tok) || glyph.includes(tok) || toned.includes(tok));
        if (matchesAll) {
          entries.push([toned, kw]);
        }
      }
      const trimmedRaw = searchQuery.trim();
      if (UNICODE_EMOJI_RE.test(trimmedRaw) && !entries.some(([g]) => g === trimmedRaw)) {
        entries.unshift([trimmedRaw, trimmedRaw]);
      }
    } else if (activeCatId === 'recent') {
      entries = recentEmojis.map((glyph) => [glyph, ALL_EMOJI_MAP.get(glyph) || glyph]);
    } else {
      const rawItems = EMOJI_CATEGORIES.find((c) => c.id === activeCatId)?.items || [];
      entries = rawItems.map(([glyph, kw]) => [applySkinTone(glyph, selectedTone), kw]);
    }

    if (entries.length === 0) {
      const none = doc.createElement('p');
      none.className = 'emoji-picker-empty';
      none.textContent = 'No matching emojis';
      grid.appendChild(none);
      return;
    }

    for (const [glyph, kw] of entries) {
      const cell = doc.createElement('button');
      cell.type = 'button';
      cell.className = 'emoji-picker-cell';
      cell.title = kw;
      cell.textContent = glyph;
      cell.addEventListener('click', () => {
        recentEmojis = [glyph, ...recentEmojis.filter((g) => g !== glyph)].slice(0, 24);
        void kvSet(recentStorageKey, recentEmojis).catch(() => {});
        onSelectEmoji?.(glyph);
        close();
      });
      grid.appendChild(cell);
    }
  }

  searchIn.addEventListener('input', () => {
    searchQuery = searchIn.value;
    renderGrid();
  });

  if (!hasNativePopover) {
    setFallbackOpen(false);
    triggerBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const nextOpen = panel.hidden;
      setFallbackOpen(nextOpen);
      if (nextOpen) searchIn.focus?.();
    });
    doc.addEventListener('click', (e) => {
      if (!panel.hidden && e.target !== triggerBtn && !e.target?.closest?.(`#${popoverId}`)) {
        close();
      }
    });
    doc.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !panel.hidden) close();
    });
  } else {
    panel.addEventListener('toggle', (ev) => {
      if (ev.newState === 'open') {
        renderGrid();
        searchIn.focus?.();
      }
    });
  }

  void kvGet(recentStorageKey, [])
    .then((saved) => {
      if (Array.isArray(saved) && saved.length > 0) {
        recentEmojis = saved.filter((g) => typeof g === 'string').slice(0, 24);
        renderGrid();
      }
    })
    .catch(() => {});

  void kvGet(toneStorageKey, '')
    .then((savedTone) => {
      if (typeof savedTone === 'string' && SKIN_TONE_MODIFIERS.some((t) => t.id === savedTone)) {
        selectedTone = savedTone;
        renderTones();
        renderGrid();
      }
    })
    .catch(() => {});

  renderTones();
  renderGrid();
  return { triggerBtn, panel, close };
}
