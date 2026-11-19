/**
 * Shared JSDoc schemas and deterministic client ID generators for Sanctuary threads.
 */

/**
 * @typedef {object} SanctuaryProgramSummary
 * @property {string} id
 * @property {string} name
 * @property {string | null} avatar
 * @property {boolean} has_profile
 * @property {string} accent_color
 * @property {object | null} theme
 * @property {boolean} active
 * @property {boolean} generating
 * @property {string | null} idle_thought
 * @property {number | null} last_active
 * @property {string | null} last_snippet
 */

/**
 * @typedef {object} SanctuaryChatMessage
 * @property {string} id
 * @property {'user' | 'program' | 'voice-call' | 'system'} role
 * @property {string} text
 * @property {Array<{ url?: string, type?: string, slot?: number }>} [media]
 * @property {string | null} [image_url]
 * @property {number} [timestamp]
 * @property {string} [sender_id]
 * @property {string} [sender_name]
 * @property {string} [prompt]
 * @property {boolean} [queued]
 */

/**
 * @typedef {object} OutboxTurnRecord
 * @property {string} msgId
 * @property {string} programId
 * @property {string} sessionId
 * @property {string} message
 * @property {string | null} imageData
 * @property {string | null} imageMime
 * @property {string | null} mediaPath
 * @property {string | null} model
 * @property {string | null} speakerId
 * @property {number} seq
 * @property {number} createdAt
 */

function randomHexSuffix() {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID().replace(/-/g, '');
  }
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Generate a client turn ID compatible with OpenSourceRunner._upsert_history_message.
 * @returns {string}
 */
export function createUserMessageId() {
  return `usr_${randomHexSuffix()}`;
}

/**
 * Generate a client-side placeholder or portrait operation ID.
 * @returns {string}
 */
export function createProgramMessageId() {
  return `prgm_${randomHexSuffix()}`;
}
