/**
 * Unified classic LM-Sanctuary dark palette and dynamic Program character accent helpers.
 */

export const SHELL_THEME = Object.freeze({
  bgCanvas: '#121214',
  bgSurface: 'rgba(22, 22, 26, 0.85)',
  bgElevated: '#1c1c22',
  borderSubtle: 'rgba(255, 255, 255, 0.08)',
  textPrimary: '#f3effa',
  textSecondary: '#8a95a5',
  accentDefault: '#9370db',
  danger: '#f87171',
  success: '#34d399',
});

export const DEFAULT_PROGRAM_THEME = Object.freeze({
  primary_accent: '#9370db',
  main_color: '#9370db',
  primary_glow: 'rgba(147, 112, 219, 0.08)',
  program_bubble: 'rgba(29, 28, 37, 0.88)',
  program_bubble_border: 'rgba(147, 112, 219, 0.12)',
  action_color: '#cbb2e8',
  quote_color: '#d6c2ef',
  accent_border: 'rgba(147, 112, 219, 0.35)',
  accent_bg: 'rgba(147, 112, 219, 0.12)',
  primary_btn_text: '#ffffff',
});

const SCOPED_VAR_NAMES = [
  '--accent-primary',
  '--accent-border',
  '--accent-bg',
  '--primary-accent',
  '--main-color',
  '--primary-glow',
  '--program-bubble',
  '--program-bubble-border',
  '--action-color',
  '--quote-color',
  '--primary-btn-text',
];

function rgbToHls({ r, g, b }) {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const maxc = Math.max(rn, gn, bn);
  const minc = Math.min(rn, gn, bn);
  const l = (minc + maxc) / 2;
  if (minc === maxc) {
    return { h: 0, l, s: 0 };
  }
  const d = maxc - minc;
  const s = l <= 0.5 ? d / (maxc + minc) : d / (2 - maxc - minc);
  let h = 0;
  if (rn === maxc) h = (gn - bn) / d + (gn < bn ? 6 : 0);
  else if (gn === maxc) h = (bn - rn) / d + 2;
  else h = (rn - gn) / d + 4;
  return { h: h / 6, l, s };
}

function hue2rgb(p, q, t) {
  let tt = t;
  if (tt < 0) tt += 1;
  if (tt > 1) tt -= 1;
  if (tt < 1 / 6) return p + (q - p) * 6 * tt;
  if (tt < 1 / 2) return q;
  if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
  return p;
}

function hlsToHex(h, l, s) {
  let r;
  let g;
  let b;
  if (s === 0) {
    r = g = b = l;
  } else {
    const q = l <= 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue2rgb(p, q, h + 1 / 3);
    g = hue2rgb(p, q, h);
    b = hue2rgb(p, q, h - 1 / 3);
  }
  return `#${[r, g, b]
    .map((v) => Math.round(Math.max(0, Math.min(255, v * 255))).toString(16).padStart(2, '0'))
    .join('')}`;
}

function deriveHarmonicTextColors(rgb) {
  const { h, s } = rgbToHls(rgb);
  return {
    action_color: hlsToHex(h, 0.76, Math.min(s, 0.6)),
    quote_color: hlsToHex(h, 0.82, Math.min(s, 0.65)),
  };
}

function deriveBubbleTokens(rgb) {
  return {
    program_bubble: `rgba(${Math.round(22 + rgb.r * 0.05)}, ${Math.round(22 + rgb.g * 0.05)}, ${Math.round(26 + rgb.b * 0.05)}, 0.88)`,
    program_bubble_border: `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.12)`,
  };
}

/**
 * Parse #RRGGBB or #RGB hex into { r, g, b }.
 * @param {string} hex
 * @returns {{ r: number, g: number, b: number } | null}
 */
export function hexToRgb(hex) {
  if (typeof hex !== 'string') return null;
  const cleaned = hex.trim().replace(/^#/, '');
  if (/^[0-9a-fA-F]{3}$/.test(cleaned)) {
    return {
      r: parseInt(cleaned[0] + cleaned[0], 16),
      g: parseInt(cleaned[1] + cleaned[1], 16),
      b: parseInt(cleaned[2] + cleaned[2], 16),
    };
  }
  if (/^[0-9a-fA-F]{6}$/.test(cleaned)) {
    return {
      r: parseInt(cleaned.slice(0, 2), 16),
      g: parseInt(cleaned.slice(2, 4), 16),
      b: parseInt(cleaned.slice(4, 6), 16),
    };
  }
  return null;
}

/**
 * Normalize a Sanctuary theme object or hex color into thread CSS custom property values.
 * @param {object | string | null | undefined} themeOrHex
 * @returns {Record<string, string>}
 */
export function deriveAccentTokens(themeOrHex) {
  if (!themeOrHex) {
    return { ...DEFAULT_PROGRAM_THEME };
  }
  if (typeof themeOrHex === 'string') {
    const rgb = hexToRgb(themeOrHex);
    if (!rgb) return { ...DEFAULT_PROGRAM_THEME };
    const accent = `#${[rgb.r, rgb.g, rgb.b].map((n) => n.toString(16).padStart(2, '0')).join('')}`;
    const lum = (rgb.r * 299 + rgb.g * 587 + rgb.b * 114) / 1000;
    return {
      primary_accent: accent,
      main_color: accent,
      primary_glow: `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.08)`,
      ...deriveBubbleTokens(rgb),
      ...deriveHarmonicTextColors(rgb),
      accent_border: `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.38)`,
      accent_bg: `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.14)`,
      primary_btn_text: lum > 140 ? '#121214' : '#ffffff',
    };
  }

  const accent = themeOrHex.primary_accent || themeOrHex.main_color || DEFAULT_PROGRAM_THEME.primary_accent;
  const rgb = hexToRgb(accent);
  const lum = rgb ? (rgb.r * 299 + rgb.g * 587 + rgb.b * 114) / 1000 : 0;
  const bubbles = rgb
    ? deriveBubbleTokens(rgb)
    : {
        program_bubble: DEFAULT_PROGRAM_THEME.program_bubble,
        program_bubble_border: DEFAULT_PROGRAM_THEME.program_bubble_border,
      };
  const harmonic = rgb
    ? deriveHarmonicTextColors(rgb)
    : {
        action_color: DEFAULT_PROGRAM_THEME.action_color,
        quote_color: DEFAULT_PROGRAM_THEME.quote_color,
      };
  return {
    primary_accent: accent,
    main_color: accent,
    primary_glow: themeOrHex.primary_glow || (rgb ? `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.08)` : DEFAULT_PROGRAM_THEME.primary_glow),
    program_bubble: bubbles.program_bubble,
    program_bubble_border: themeOrHex.program_bubble_border || bubbles.program_bubble_border,
    action_color: themeOrHex.action_color || harmonic.action_color,
    quote_color: themeOrHex.quote_color || harmonic.quote_color,
    accent_border: themeOrHex.accent_border || (rgb ? `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.38)` : DEFAULT_PROGRAM_THEME.accent_border),
    accent_bg: themeOrHex.accent_bg || (rgb ? `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.14)` : DEFAULT_PROGRAM_THEME.accent_bg),
    primary_btn_text: themeOrHex.primary_btn_text || (lum > 140 ? '#121214' : '#ffffff'),
  };
}

function applyThemeTokensToElement(targetEl, themeOrHex) {
  if (!targetEl?.style?.setProperty) return;
  const tokens = deriveAccentTokens(themeOrHex);
  targetEl.style.setProperty('--accent-primary', tokens.primary_accent);
  targetEl.style.setProperty('--accent-border', tokens.accent_border);
  targetEl.style.setProperty('--accent-bg', tokens.accent_bg);
  targetEl.style.setProperty('--primary-accent', tokens.primary_accent);
  targetEl.style.setProperty('--main-color', tokens.main_color);
  targetEl.style.setProperty('--primary-glow', tokens.primary_glow);
  targetEl.style.setProperty('--program-bubble', tokens.program_bubble);
  targetEl.style.setProperty('--program-bubble-border', tokens.program_bubble_border);
  targetEl.style.setProperty('--action-color', tokens.action_color);
  targetEl.style.setProperty('--quote-color', tokens.quote_color);
  targetEl.style.setProperty('--primary-btn-text', tokens.primary_btn_text);
}

/**
 * Apply active Program theme tokens onto :root so unified dialogs, toggles, and active rings match.
 * @param {object | string | null | undefined} themeOrHex
 * @param {Document} [doc]
 */
export function applyRootProgramTheme(themeOrHex, doc = globalThis.document) {
  if (!doc?.documentElement) return;
  applyThemeTokensToElement(doc.documentElement, themeOrHex);
  try {
    if (typeof globalThis.sanctuaryBrowserHost?.setProgramTheme === 'function') {
      globalThis.sanctuaryBrowserHost.setProgramTheme({
        ...deriveAccentTokens(themeOrHex),
        bg_canvas: SHELL_THEME.bgCanvas,
      });
    }
  } catch {
    // Ignore host theme bridge failures in standalone mode
  }
}

/**
 * Inject Program accent variables onto a scoped container.
 * @param {HTMLElement | { style?: { setProperty: Function } } | null} containerEl
 * @param {object | string | null | undefined} themeOrHex
 */
export function applyScopedProgramTheme(containerEl, themeOrHex) {
  applyThemeTokensToElement(containerEl, themeOrHex);
}

/**
 * Remove scoped Program accent variables from a container.
 * @param {HTMLElement | { style?: { removeProperty: Function } } | null} containerEl
 */
export function clearScopedProgramTheme(containerEl) {
  if (!containerEl?.style?.removeProperty) return;
  for (const prop of SCOPED_VAR_NAMES) {
    containerEl.style.removeProperty(prop);
  }
}
