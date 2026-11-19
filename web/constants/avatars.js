/**
 * Shared user outline symbol and neutral dark-obsidian circular fallback avatar
 * for social timelines, replies, and compose strips when an avatar URL is unset.
 */
export const USER_ICON_PATHS =
  '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle>';

export function createUserIconSvg({ size = 20, stroke = 'currentColor', strokeWidth = 2 } = {}) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${stroke}" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${USER_ICON_PATHS}</svg>`;
}

export const DEFAULT_AVATAR_DATA_URI =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40" fill="none">' +
      '<rect width="40" height="40" rx="20" fill="#1c1c22"/>' +
      `<g transform="translate(8 8)" stroke="#98a0b0" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${USER_ICON_PATHS}</g>` +
    '</svg>'
  );
