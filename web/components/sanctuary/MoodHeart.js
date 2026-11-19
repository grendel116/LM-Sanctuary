import { resolveSanctuaryMediaUrl } from '../../queries/sanctuary.js';
import { createClassicModalDialog } from './SanctuaryDialog.js';

const HEART_SVG = `<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20.42 4.58a5.4 5.4 0 0 0-7.65 0l-.77.78-.77-.78a5.4 5.4 0 0 0-7.65 0C1.46 6.7 1.33 10.28 4 13l8 8 8-8c2.67-2.72 2.54-6.3.42-8.42z"></path></svg>`;

const FALLBACK_MOODS = {
  baseline: { emoji: '✨', label: 'Serene', color: '#9370db', glow: 'rgba(147, 112, 219, 0.85)' },
  calm: { emoji: '✨', label: 'Serene', color: '#9370db', glow: 'rgba(147, 112, 219, 0.85)' },
  excited: { emoji: '⚡', label: 'Excited', color: '#f59e0b', glow: 'rgba(245, 158, 11, 0.85)' },
  intimate: { emoji: '💜', label: 'Intimate', color: '#ec4899', glow: 'rgba(236, 72, 153, 0.85)' },
  intense: { emoji: '🔥', label: 'Intense', color: '#ef4444', glow: 'rgba(239, 68, 68, 0.85)' },
  jealous: { emoji: '💚', label: 'Possessive', color: '#10b981', glow: 'rgba(16, 185, 129, 0.85)' },
  sad: { emoji: '💧', label: 'Melancholy', color: '#64748b', glow: 'rgba(100, 116, 139, 0.85)' },
  playful: { emoji: '✨', label: 'Playful', color: '#eab308', glow: 'rgba(234, 179, 8, 0.85)' },
  warm: { emoji: '💖', label: 'Warm', color: '#f43f5e', glow: 'rgba(244, 63, 94, 0.85)' },
};

function buildMoodRegistry(moodMeta) {
  const reg = { ...FALLBACK_MOODS };
  if (!moodMeta || typeof moodMeta !== 'object') return reg;
  const baseColor = moodMeta.base_color || '#9370db';
  if (moodMeta.baseline) {
    reg.baseline = {
      emoji: moodMeta.baseline.emoji || '✨',
      label: moodMeta.baseline.label || 'Serene',
      color: moodMeta.baseline.color || baseColor,
      glow: moodMeta.baseline.glow || 'rgba(147, 112, 219, 0.85)',
    };
    reg.calm = reg.baseline;
  }
  if (moodMeta.moods && typeof moodMeta.moods === 'object') {
    for (const [key, m] of Object.entries(moodMeta.moods)) {
      if (!m || typeof m !== 'object') continue;
      reg[key] = {
        emoji: m.emoji || FALLBACK_MOODS[key]?.emoji || '✨',
        label: m.label || `${key.charAt(0).toUpperCase()}${key.slice(1)}`,
        color: m.color || baseColor,
        glow: m.glow || FALLBACK_MOODS[key]?.glow || 'rgba(147, 112, 219, 0.85)',
      };
    }
  }
  return reg;
}

function getMoodInfo(registry, moodName) {
  const key = String(moodName || '').trim().toLowerCase();
  if (!key) return registry.baseline;
  return registry[key] || {
    emoji: '✨',
    label: `${key.charAt(0).toUpperCase()}${key.slice(1)}`,
    color: registry.baseline.color,
    glow: registry.baseline.glow,
  };
}

function deriveRecentMoodTrail(messages = [], registry) {
  if (!Array.isArray(messages)) return [];
  const trail = [];
  for (let i = messages.length - 1; i >= 0 && trail.length < 5; i -= 1) {
    const msg = messages[i];
    if (!msg || (msg.role !== 'program' && msg.role !== 'model')) continue;
    const msgId = String(msg.id || '');
    const txt = String(msg.text || '').trim();
    if (msgId.startsWith('img_') || (txt.startsWith('![') && txt.endsWith(')'))) continue;
    if (msg.mood && typeof msg.mood === 'object' && msg.mood.name) {
      const meta = getMoodInfo(registry, msg.mood.name);
      trail.push({
        emoji: meta.emoji,
        label: meta.label,
        color: msg.mood.color || meta.color,
        intensity: Number(msg.mood.intensity ?? 0),
      });
    }
  }
  return trail.reverse();
}

/**
 * Interactive Mood Heart header control + classic .mood-status-card <dialog>.
 */
export function createMoodHeart({ programName = 'Program' } = {}) {
  const doc = globalThis.document;
  let registry = buildMoodRegistry(null);
  let currentHeartState = {
    name: 'baseline',
    color: '#9370db',
    glow: 'rgba(147, 112, 219, 0.85)',
    speed: '2.0s',
    intensity: 0.0,
  };
  let currentInversion = '';
  let latestInversionMap = {};
  let recentTrail = [];
  let currentName = programName;

  const buttonEl = doc.createElement('button');
  buttonEl.type = 'button';
  buttonEl.id = 'header-heart-pulse';
  buttonEl.className = 'heart-pulse';
  buttonEl.setAttribute('aria-label', `${programName} Mood State`);
  buttonEl.title = `${programName} Mood State`;
  buttonEl.innerHTML = HEART_SVG;

  function playSparkleChime() {
    try {
      const audio = new globalThis.Audio(resolveSanctuaryMediaUrl('/sparkle.mp3'));
      audio.volume = 0.25;
      void audio.play?.()?.catch?.(() => {});
    } catch {
      // Ignore autoplay restrictions cleanly
    }
  }

  function setMoodMetadata(moodMeta) {
    registry = buildMoodRegistry(moodMeta);
  }

  function updateMood(state, inversionActive = '', inversionState = {}, nextProgramName = null, historyMessages = null) {
    if (nextProgramName) {
      currentName = nextProgramName;
      buttonEl.setAttribute('aria-label', `${currentName} Mood State`);
      buttonEl.title = `${currentName} Mood State`;
    }
    if (state && typeof state === 'object') {
      currentHeartState = { ...currentHeartState, ...state };
    }
    const wasInverted = Boolean(currentInversion);
    const invFromMap = inversionState && typeof inversionState === 'object' ? inversionState.active_inversion : '';
    currentInversion = String(inversionActive || invFromMap || '');
    if (inversionState && typeof inversionState === 'object') {
      latestInversionMap = inversionState;
    }
    if (Array.isArray(historyMessages)) {
      recentTrail = deriveRecentMoodTrail(historyMessages, registry);
    }

    const meta = getMoodInfo(registry, currentHeartState.name);
    const heartColor = currentHeartState.color || meta.color || '#9370db';
    const heartGlow = currentHeartState.glow || meta.glow || 'rgba(147, 112, 219, 0.85)';
    const heartSpeed = currentHeartState.speed || '2.0s';

    buttonEl.style.setProperty('--heart-color', heartColor);
    buttonEl.style.setProperty('--heart-glow', heartGlow);
    buttonEl.style.setProperty('--heart-speed', heartSpeed);
    buttonEl.style.color = heartColor;

    buttonEl.classList.toggle('inversion-active', Boolean(currentInversion));
    if (currentInversion && !wasInverted) {
      buttonEl.classList.add('burst');
      playSparkleChime();
      setTimeout(() => buttonEl.classList.remove('burst'), 1500);
    }
  }

  function openModal() {
    const modal = createClassicModalDialog({
      id: 'program-mood-dialog',
      maxWidth: '440px',
      onClose: () => modal.dialog.remove(),
    });

    const modalHeading = doc.createElement('h3');
    modalHeading.id = modal.titleId;
    modalHeading.className = 'classic-modal-title';
    modalHeading.style.borderBottom = '1px solid rgba(255, 255, 255, 0.08)';
    modalHeading.style.paddingBottom = '10px';
    modalHeading.style.marginBottom = '14px';

    const titleIcon = doc.createElement('span');
    titleIcon.style.cssText = 'display: inline-flex; align-items: center; color: var(--primary-accent, #9370db);';
    titleIcon.innerHTML = HEART_SVG;

    const titleText = doc.createElement('span');
    titleText.textContent = 'Emotional State & Inversion';
    modalHeading.append(titleIcon, titleText);
    modal.card.appendChild(modalHeading);

    const meta = getMoodInfo(registry, currentHeartState.name);
    const activeColor = currentHeartState.color || meta.color || '#9370db';
    const activeGlow = currentHeartState.glow || meta.glow || 'rgba(147, 112, 219, 0.45)';
    const intensityPct = Math.round(Math.max(0, Math.min(1, Number(currentHeartState.intensity ?? 0))) * 100);

    const card = doc.createElement('div');
    card.className = 'mood-status-card';
    card.style.setProperty('--card-glow', activeGlow);

    const headerBox = doc.createElement('div');
    headerBox.className = 'mood-header-box';

    const emojiEl = doc.createElement('div');
    emojiEl.className = 'mood-header-emoji';
    emojiEl.textContent = meta.emoji;

    const info = doc.createElement('div');
    info.className = 'mood-header-info';

    const prefix = doc.createElement('div');
    prefix.className = 'mood-header-prefix';
    prefix.textContent = `${currentName}'s State`;

    const titleEl = doc.createElement('div');
    titleEl.className = 'mood-header-title';
    titleEl.style.color = activeColor;
    titleEl.textContent = meta.label;

    info.append(prefix, titleEl);
    headerBox.append(emojiEl, info);
    card.appendChild(headerBox);

    const metricRow = doc.createElement('div');
    metricRow.className = 'mood-metric-row';

    const metricHeader = doc.createElement('div');
    metricHeader.className = 'mood-metric-header';
    const metricLbl = doc.createElement('span');
    metricLbl.textContent = 'Emotional Intensity';
    const metricVal = doc.createElement('span');
    metricVal.className = 'mood-metric-value';
    metricVal.style.color = activeColor;
    metricVal.textContent = `${intensityPct}%`;
    metricHeader.append(metricLbl, metricVal);

    const track = doc.createElement('div');
    track.className = 'mood-progress-track';
    const fill = doc.createElement('div');
    fill.className = 'mood-progress-fill';
    fill.style.width = `${intensityPct}%`;
    fill.style.background = `linear-gradient(90deg, #9370db, ${activeColor})`;
    fill.style.boxShadow = `0 0 8px ${activeGlow}`;
    track.appendChild(fill);

    metricRow.append(metricHeader, track);
    card.appendChild(metricRow);

    const activeInv = latestInversionMap?.active_inversion || currentInversion;
    if (activeInv) {
      const invMeta = getMoodInfo(registry, activeInv);
      const invBanner = doc.createElement('div');
      invBanner.style.cssText = `font-size: 0.78rem; padding: 8px 12px; border-radius: 8px; background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.1); color: ${invMeta.color || '#f472b6'}; font-weight: 500;`;
      const strong = doc.createElement('strong');
      strong.textContent = invMeta.label || activeInv;
      invBanner.append(doc.createTextNode('⚡ Inversion Active: '), strong);
      card.appendChild(invBanner);
    }

    const trailWrap = doc.createElement('div');
    trailWrap.className = 'mood-trail-container';
    const trailLbl = doc.createElement('span');
    trailLbl.className = 'mood-trail-label';
    trailLbl.textContent = 'Recent Moods:';
    const trailDots = doc.createElement('div');
    trailDots.className = 'mood-trail-dots';
    for (let i = 0; i < 5; i += 1) {
      const dot = doc.createElement('div');
      if (i < recentTrail.length) {
        const entry = recentTrail[i];
        dot.className = 'mood-trail-dot';
        dot.style.setProperty('--dot-color', entry.color);
        dot.style.setProperty('--dot-glow', entry.color);
        dot.title = `${entry.emoji} ${entry.label} (${Math.round((entry.intensity || 0) * 100)}%)`;
      } else {
        dot.className = 'mood-trail-dot empty';
        dot.title = 'No history turn recorded';
      }
      trailDots.appendChild(dot);
    }
    trailWrap.append(trailLbl, trailDots);
    card.appendChild(trailWrap);

    modal.card.appendChild(card);
    modal.open();
  }

  buttonEl.addEventListener('click', openModal);

  return {
    buttonEl,
    setMoodMetadata,
    updateMood,
    openModal,
    setGeneratingPulse(active) {
      buttonEl.classList.toggle('jiggling', Boolean(active));
    },
  };
}
