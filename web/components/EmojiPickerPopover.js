import { kvGet, kvSet } from '../storage/nativeStore.js';

const SMILEY_SVG = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><path d="M8 14s1.5 2 4 2 4-2 4-2"></path><line x1="9" y1="9" x2="9.01" y2="9"></line><line x1="15" y1="9" x2="15.01" y2="9"></line></svg>`;

export const EMOJI_CATEGORIES = [
  {
    id: 'smileys',
    icon: '😀',
    label: 'Smileys',
    items: [
      ['😀', 'grin smile happy'],
      ['😃', 'smiley happy'],
      ['😄', 'laugh grin'],
      ['😁', 'beam teeth grin'],
      ['😆', 'laugh squint'],
      ['😅', 'sweat grin relief'],
      ['🤣', 'rofl laugh'],
      ['😂', 'joy tears laugh'],
      ['🙂', 'smile mild'],
      ['🙃', 'upside down silly'],
      ['😉', 'wink'],
      ['😊', 'blush happy warm'],
      ['😇', 'angel halo'],
      ['🥰', 'love hearts'],
      ['😍', 'heart eyes love'],
      ['🤩', 'star struck'],
      ['😘', 'kiss blow'],
      ['😋', 'yum delicious'],
      ['😛', 'tongue'],
      ['😜', 'wink tongue'],
      ['🤪', 'zany goofy'],
      ['🤨', 'raised eyebrow skeptical'],
      ['🧐', 'monocle inspect'],
      ['🤓', 'nerd glasses'],
      ['😎', 'cool sunglasses'],
      ['🥳', 'party celebrate'],
      ['😏', 'smirk'],
      ['😒', 'unamused'],
      ['😔', 'pensive sad'],
      ['😴', 'sleep tired'],
      ['🤔', 'think hmm'],
      ['🤫', 'shh quiet secret'],
      ['🤯', 'mind blown'],
      ['🥺', 'pleading puppy'],
      ['😭', 'cry sob'],
      ['😡', 'angry mad'],
    ],
  },
  {
    id: 'gestures',
    icon: '👋',
    label: 'Gestures',
    items: [
      ['👋', 'wave hello hi bye'],
      ['🤚', 'raised back hand'],
      ['🖐️', 'hand five stop'],
      ['✋', 'raised hand stop'],
      ['👌', 'ok perfect'],
      ['🤌', 'pinched fingers'],
      ['✌️', 'peace victory'],
      ['🤞', 'crossed fingers luck'],
      ['🤟', 'love you'],
      ['🤘', 'rock on metal'],
      ['🤙', 'call me shaka'],
      ['👍', 'thumbs up yes good'],
      ['👎', 'thumbs down no'],
      ['✊', 'fist solidarity'],
      ['👊', 'fist bump'],
      ['👏', 'clap applause'],
      ['🙌', 'raise hands hooray'],
      ['🫶', 'heart hands love'],
      ['🤝', 'handshake agree'],
      ['🙏', 'please thanks pray'],
      ['💪', 'strong muscle flex'],
      ['🫂', 'hug embrace'],
      ['👀', 'eyes look'],
      ['🧠', 'brain mind smart'],
      ['🫵', 'point you'],
      ['👉', 'point right'],
      ['👈', 'point left'],
      ['👆', 'point up'],
      ['👇', 'point down'],
      ['✍️', 'write note'],
    ],
  },
  {
    id: 'hearts',
    icon: '❤️',
    label: 'Hearts',
    items: [
      ['❤️', 'red heart love'],
      ['🧡', 'orange heart'],
      ['💛', 'yellow heart'],
      ['💚', 'green heart'],
      ['💙', 'blue heart'],
      ['💜', 'purple heart'],
      ['🖤', 'black heart'],
      ['🤍', 'white heart'],
      ['🩷', 'pink heart'],
      ['💖', 'sparkling heart'],
      ['💗', 'growing heart'],
      ['💓', 'beating heart'],
      ['💞', 'revolving hearts'],
      ['💕', 'two hearts'],
      ['💘', 'cupid arrow heart'],
      ['💔', 'broken heart'],
      ['❤️‍🔥', 'heart on fire'],
      ['💯', 'hundred 100 perfect'],
      ['💢', 'anger symbol'],
      ['💥', 'boom collision'],
      ['💫', 'dizzy star'],
      ['💦', 'sweat drops'],
      ['💤', 'zzz sleep'],
      ['💬', 'speech bubble chat'],
      ['💭', 'thought balloon'],
      ['🎉', 'party popper confetti'],
      ['🎊', 'confetti ball'],
      ['🪩', 'mirror disco ball'],
      ['🏆', 'trophy win'],
      ['🚩', 'flag red'],
    ],
  },
  {
    id: 'nature',
    icon: '🌿',
    label: 'Nature',
    items: [
      ['🌿', 'herb leaf plant'],
      ['🌱', 'seedling sprout'],
      ['🌲', 'evergreen pine tree'],
      ['🌳', 'tree'],
      ['🌸', 'cherry blossom flower'],
      ['🌹', 'rose flower'],
      ['🌻', 'sunflower'],
      ['🍄', 'mushroom'],
      ['☀️', 'sun sunny'],
      ['🌤️', 'partly sunny cloud'],
      ['🌧️', 'rain cloud'],
      ['⛈️', 'thunderstorm lightning'],
      ['🌈', 'rainbow'],
      ['❄️', 'snowflake cold winter'],
      ['🌊', 'ocean wave water'],
      ['🔥', 'fire flame hot lit'],
      ['⭐', 'star'],
      ['🌟', 'glowing star'],
      ['🌙', 'crescent moon night'],
      ['🌍', 'earth globe world'],
      ['🐱', 'cat kitty'],
      ['🐶', 'dog puppy'],
      ['🦊', 'fox'],
      ['🦉', 'owl bird'],
      ['🐦', 'bird'],
      ['🐝', 'bee'],
      ['🦋', 'butterfly'],
      ['🐙', 'octopus'],
      ['☕', 'coffee tea cup'],
      ['🍕', 'pizza food'],
    ],
  },
  {
    id: 'objects',
    icon: '✨',
    label: 'Objects',
    items: [
      ['✨', 'sparkles magic stars'],
      ['⚡', 'lightning zap energy'],
      ['💡', 'lightbulb idea'],
      ['🔔', 'bell alert'],
      ['📌', 'pushpin pin'],
      ['📎', 'paperclip attach'],
      ['🔗', 'link chain'],
      ['📝', 'memo note write'],
      ['📖', 'book read'],
      ['📰', 'newspaper news'],
      ['📷', 'camera photo'],
      ['🎥', 'movie camera video'],
      ['🎵', 'music note'],
      ['🎶', 'music notes'],
      ['🎧', 'headphones audio'],
      ['🎤', 'microphone mic'],
      ['💻', 'laptop computer code'],
      ['🖥️', 'desktop computer'],
      ['📱', 'phone mobile'],
      ['⚙️', 'gear settings'],
      ['🔧', 'wrench tool'],
      ['🔒', 'lock security privacy'],
      ['🔑', 'key access'],
      ['🚀', 'rocket launch space'],
      ['🛸', 'ufo'],
      ['🧭', 'compass explore'],
      ['✅', 'check done yes'],
      ['❌', 'cross no'],
      ['⚠️', 'warning caution'],
      ['♾️', 'infinity'],
    ],
  },
];

const ALL_EMOJI_MAP = new Map();
for (const cat of EMOJI_CATEGORIES) {
  for (const [glyph, keywords] of cat.items) {
    if (!ALL_EMOJI_MAP.has(glyph)) {
      ALL_EMOJI_MAP.set(glyph, keywords);
    }
  }
}

/**
 * Lightweight zero-dependency emoji picker popover tethered to an icon trigger button.
 */
export function createEmojiPicker({
  popoverId = 'compose-emoji-popover',
  onSelectEmoji,
} = {}) {
  const doc = globalThis.document;
  const recentStorageKey = 'recent_emojis';
  let recentEmojis = [];
  let activeCatId = 'smileys';
  let searchQuery = '';

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

  const searchIn = doc.createElement('input');
  searchIn.type = 'search';
  searchIn.className = 'onboarding-input emoji-picker-search';
  searchIn.placeholder = 'Search emoji...';
  searchIn.setAttribute('aria-label', 'Search emoji');
  searchIn.setAttribute('autocomplete', 'off');
  searchIn.setAttribute('autocorrect', 'off');
  searchIn.setAttribute('autocapitalize', 'none');
  searchIn.setAttribute('spellcheck', 'false');

  const catsBar = doc.createElement('div');
  catsBar.className = 'emoji-picker-cats';

  const grid = doc.createElement('div');
  grid.className = 'emoji-picker-grid';

  panel.append(searchIn, catsBar, grid);

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
      for (const [glyph, kw] of ALL_EMOJI_MAP.entries()) {
        if (kw.includes(cleanQ) || glyph.includes(cleanQ)) {
          entries.push([glyph, kw]);
        }
      }
    } else if (activeCatId === 'recent') {
      entries = recentEmojis.map((glyph) => [glyph, ALL_EMOJI_MAP.get(glyph) || glyph]);
    } else {
      entries = EMOJI_CATEGORIES.find((c) => c.id === activeCatId)?.items || [];
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
        recentEmojis = [glyph, ...recentEmojis.filter((g) => g !== glyph)].slice(0, 18);
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
        recentEmojis = saved.filter((g) => typeof g === 'string').slice(0, 18);
        renderGrid();
      }
    })
    .catch(() => {});

  renderGrid();
  return { triggerBtn, panel, close };
}
