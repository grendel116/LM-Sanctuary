import { DEFAULT_AVATAR_DATA_URI } from '../../constants/avatars.js';
import { applyScopedProgramTheme, clearScopedProgramTheme } from '../../constants/theme.js';
import {
  resolveProgramAvatarUrl,
  resolveSanctuaryMediaUrl,
} from '../../queries/sanctuary.js';
import { createFediverseShareButton } from '../FediverseShareButton.js';
import {
  createPortraitGrid,
  MAX_IMAGES_PER_ROW,
  openMediaLightbox,
  updatePortraitGridToolbar,
} from './PortraitGrid.js';

export const LIVE_ROW_SELECTOR = '.message-row:not(#welcome-message):not(.typing-row):not(.thought-row)';

const REROLL_USER_SVG = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 17 4 12 9 7"></polyline><path d="M20 18v-2a4 4 0 0 0-4-4H4"></path></svg>`;
const REROLL_PROGRAM_SVG = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"></path></svg>`;
const EDIT_SVG = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 1 1 3 3L12 15l-4 1 1-4z"></path></svg>`;
const DELETE_SVG = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg>`;
export const SPEAK_SVG = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"></path></svg>`;
export const SPEAK_LOADING_SVG = `<svg class="animate-spin" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9" opacity="0.28"></circle><path d="M21 12a9 9 0 0 0-9-9"></path></svg>`;
export const SPEAK_STOP_SVG = `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2.5"></rect></svg>`;

export function syncSpeakButtonVisual(btn, state = 'idle') {
  if (!btn) return;
  const normalized = state === 'loading' || state === 'playing' ? state : 'idle';
  const isLoading = normalized === 'loading';
  const isPlaying = normalized === 'playing';
  const isActive = isLoading || isPlaying;
  btn.classList.toggle('is-loading', isLoading);
  btn.classList.toggle('is-speaking', isPlaying);
  btn.closest?.('.message')?.classList?.toggle?.('is-tts-active', isActive);
  btn.setAttribute('aria-busy', isLoading ? 'true' : 'false');
  btn.setAttribute('aria-pressed', isActive ? 'true' : 'false');
  if (isLoading) {
    btn.innerHTML = SPEAK_LOADING_SVG;
    btn.title = 'Generating speech… (click to cancel)';
    btn.setAttribute('aria-label', 'Generating speech (click to cancel)');
  } else if (isPlaying) {
    btn.innerHTML = SPEAK_STOP_SVG;
    btn.title = 'Stop speaking';
    btn.setAttribute('aria-label', 'Stop speaking');
  } else {
    btn.innerHTML = SPEAK_SVG;
    btn.title = 'Speak message';
    btn.setAttribute('aria-label', 'Speak message');
  }
}
const PHONE_SVG = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"></path></svg>`;
const CHEVRON_DOWN_SVG = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"></polyline></svg>`;

function getLogIconSvg(kind) {
  const svgs = {
    timer: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>`,
    file: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg>`,
    webpage: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"></circle><line x1="2" y1="12" x2="22" y2="12"></line><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path></svg>`,
    folder: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>`,
    search: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>`,
    edit: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"></path><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path></svg>`,
    command: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="4 17 10 11 4 5"></polyline><line x1="12" y1="19" x2="20" y2="19"></line></svg>`,
    gear: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>`,
  };
  return svgs[kind] || svgs.command;
}

function fallbackMsgId() {
  return `local_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export function formatMessageTimestamp(ts) {
  if (!ts) return '';
  const ms = Number(ts) > 1e12 ? Number(ts) : Number(ts) * 1000;
  if (!Number.isFinite(ms)) return '';
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function computeContentHash(msg) {
  const mediaList = normalizeTurnMedia(msg);
  const str = JSON.stringify([
    msg.id,
    msg.role,
    msg.text,
    mediaList.map((m) => m.url),
    (msg.tool_calls || []).map((t) => t.id || t.name),
    msg.timestamp,
    msg.duration,
    msg.sender_id,
    msg.sender_name,
    msg.shared_post ? (msg.shared_post.url || msg.shared_post.text || msg.shared_post.authorHandle || msg.shared_post.authorName) : null,
    msg.user_note ?? null,
    Boolean(msg.queued),
  ]);
  let hash = 0;
  for (let i = 0; i < str.length; i += 1) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash &= hash;
  }
  return `h_${Math.abs(hash).toString(36)}`;
}

function safeHttpsUrl(raw) {
  const s = String(raw || '').trim();
  return /^https:\/\//i.test(s) ? s.slice(0, 500) : '';
}

export function normalizeSharedPostCard(post) {
  if (!post || typeof post !== 'object') return null;
  if (post.authorName !== undefined && post.mediaUrl !== undefined) {
    const authorName = String(post.authorName || '').trim().slice(0, 120);
    const authorHandle = String(post.authorHandle || '').trim().slice(0, 120);
    const authorAvatar = safeHttpsUrl(post.authorAvatar);
    const text = String(post.text || '').replace(/\s+/g, ' ').trim().slice(0, 600);
    const mediaUrl = safeHttpsUrl(post.mediaUrl);
    const mediaAlt = String(post.mediaAlt || '').trim().slice(0, 240);
    const url = safeHttpsUrl(post.url);
    const network = String(post.network || 'fediverse').slice(0, 32);
    const mediaItems = Array.isArray(post.mediaItems)
      ? post.mediaItems
          .slice(0, 10)
          .map((m) => {
            const mUrl = safeHttpsUrl(m?.url);
            if (!mUrl) return null;
            return {
              url: mUrl,
              prompt: String(m?.prompt || '').trim().slice(0, 240),
              type: String(m?.type || 'image'),
            };
          })
          .filter(Boolean)
      : [];
    if (!authorName && !text && !mediaUrl) return null;
    return {
      authorName: authorName || 'Author',
      authorHandle,
      authorAvatar,
      text,
      mediaUrl,
      mediaAlt,
      url,
      network,
      ...(mediaItems.length > 1 ? { mediaItems } : {}),
    };
  }

  const plainText = (
    post.content_text ||
    post.text ||
    String(post.content_html || post.contentHtml || post.sanitizedHtml || '').replace(/<[^>]*>/g, ' ')
  )
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 600);
  const rawList =
    Array.isArray(post.mediaItems) && post.mediaItems.length > 0
      ? post.mediaItems
      : Array.isArray(post.attachments) && post.attachments.length > 0
        ? post.attachments
        : Array.isArray(post.media) && post.media.length > 0
          ? post.media
          : [];
  const mediaItems = rawList
    .slice(0, 10)
    .map((m) => {
      const mUrl = safeHttpsUrl(m?.url || m?.previewUrl);
      if (!mUrl) return null;
      return {
        url: mUrl,
        prompt: String(m?.alt_text || m?.description || m?.prompt || '').trim().slice(0, 240),
        type: String(m?.type || m?.mime_type || m?.mimeType || 'image'),
      };
    })
    .filter(Boolean);
  const firstMedia = rawList[0] || null;
  const authorName = String(post.author?.name || post.author?.displayName || post.author?.acct || 'Author').trim().slice(0, 120);
  const rawHandle = String(post.author?.handle || post.author?.acct || '').replace(/^@/, '');
  const authorHandle = rawHandle ? `@${rawHandle}`.slice(0, 120) : '';
  const authorAvatar = safeHttpsUrl(post.author?.avatar_url || post.author?.avatar);
  const mediaUrl = firstMedia ? safeHttpsUrl(firstMedia.url || firstMedia.previewUrl) : '';
  const mediaAlt = firstMedia ? String(firstMedia.alt_text || firstMedia.description || '').trim().slice(0, 240) : '';
  const url = safeHttpsUrl(post.url);
  const network = String(post.protocol || post.network || 'mastodon').slice(0, 32);
  if (!authorName && !plainText && !mediaUrl) return null;
  return {
    authorName,
    authorHandle,
    authorAvatar,
    text: plainText,
    mediaUrl,
    mediaAlt,
    url,
    network,
    ...(mediaItems.length > 1 ? { mediaItems } : {}),
  };
}

export function formatSharedPostForLlm(sharedPost, userNote = '') {
  const sp = normalizeSharedPostCard(sharedPost);
  const cleanNote = String(userNote || '').trim();
  if (!sp) return cleanNote;
  const byline = sp.network === 'web'
    ? `[Shared webpage from ${sp.authorName}${sp.url ? ` (${sp.url})` : ''}]`
    : `[Shared post by ${sp.authorName}${sp.authorHandle ? ` (${sp.authorHandle})` : ''}]`;
  const parts = [byline];
  if (sp.text) parts.push(sp.text);
  if (sp.mediaUrl) {
    parts.push(`[Image${sp.mediaAlt ? `: ${sp.mediaAlt}` : ' attached'}]`);
  }
  const block = parts.join('\n');
  return cleanNote ? `${block}\n\n${cleanNote}` : block;
}

/**
 * Recover a shared-post card + user note from a flattened LLM text block when
 * `msg.shared_post` metadata was stripped (e.g. legacy rerolled/edited turns).
 */
export function parseInlineSharedPostFallback(rawText) {
  const text = String(rawText || '');
  if (!text.startsWith('[Shared ')) return null;
  const match = /^\[(Shared post by|Shared webpage from)\s+([^\n\]]+?)(?:\s+\((@[^\n)]+|https:\/\/[^\n)]+)\))?\]\n([\s\S]*)$/.exec(text);
  if (!match) return null;
  const isWeb = match[1] === 'Shared webpage from';
  const authorName = match[2].trim();
  const metaParen = (match[3] || '').trim();
  const remainder = match[4] || '';
  const splitIdx = remainder.indexOf('\n\n');
  const blockBody = (splitIdx >= 0 ? remainder.slice(0, splitIdx) : remainder).trim();
  const userNote = splitIdx >= 0 ? remainder.slice(splitIdx + 2).trim() : '';
  const bodyLines = blockBody
    .split('\n')
    .filter((line) => !/^\[Image(?::\s*.*|\s+attached)\]$/.test(line.trim()));
  const postText = bodyLines.join(' ').trim();
  const sharedPost = normalizeSharedPostCard({
    authorName,
    authorHandle: !isWeb && metaParen.startsWith('@') ? metaParen : '',
    authorAvatar: '',
    text: postText,
    mediaUrl: '',
    mediaAlt: '',
    url: isWeb && metaParen.startsWith('https://') ? metaParen : '',
    network: isWeb ? 'web' : 'fediverse',
  });
  if (!sharedPost) return null;
  return { sharedPost, userNote };
}

export function createSharedPostEmbedCard(sharedPost, { onRemove } = {}) {
  const doc = globalThis.document;
  const sp = normalizeSharedPostCard(sharedPost);
  const card = doc.createElement('div');
  if (!sp) return card;

  const isPreview = typeof onRemove === 'function';
  card.className = `shared-post-card${isPreview ? ' is-composer-preview' : ''}`;

  const mainCol = doc.createElement('div');
  mainCol.className = 'shared-post-main';

  const headerRow = doc.createElement('div');
  headerRow.className = 'shared-post-header';

  const avatarImg = doc.createElement('img');
  avatarImg.className = 'shared-post-avatar';
  avatarImg.src = sp.authorAvatar || DEFAULT_AVATAR_DATA_URI;
  avatarImg.alt = sp.authorName;

  const authorEl = doc.createElement('strong');
  authorEl.className = 'shared-post-author';
  authorEl.textContent = sp.authorName;

  headerRow.append(avatarImg, authorEl);
  if (sp.authorHandle) {
    const handleEl = doc.createElement('span');
    handleEl.className = 'shared-post-handle';
    handleEl.textContent = sp.authorHandle;
    headerRow.appendChild(handleEl);
  }
  mainCol.appendChild(headerRow);

  if (sp.text || sp.mediaUrl) {
    const bodyP = doc.createElement('p');
    bodyP.className = 'shared-post-text';
    bodyP.textContent = sp.text || 'Shared image post';
    mainCol.appendChild(bodyP);
  }

  card.appendChild(mainCol);

  if (sp.mediaUrl) {
    const thumbBtn = doc.createElement('button');
    thumbBtn.type = 'button';
    thumbBtn.className = 'shared-post-thumb-btn';
    thumbBtn.setAttribute(
      'aria-label',
      sp.mediaAlt ? `View shared image: ${sp.mediaAlt}` : 'View shared post image'
    );
    const thumbImg = doc.createElement('img');
    thumbImg.className = 'shared-post-thumb';
    thumbImg.src = sp.mediaUrl;
    thumbImg.alt = sp.mediaAlt || 'Shared post media';
    thumbImg.loading = 'lazy';
    thumbBtn.appendChild(thumbImg);
    thumbBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const gallery =
        Array.isArray(sp.mediaItems) && sp.mediaItems.length > 0
          ? sp.mediaItems
          : [{ url: sp.mediaUrl, prompt: sp.mediaAlt || '', type: 'image' }];
      openMediaLightbox(sp.mediaUrl, {
        source: 'social',
        initialIndex: 0,
        prompt: sp.mediaAlt || '',
        galleryItems: gallery,
      });
    });
    card.appendChild(thumbBtn);
  }

  if (isPreview) {
    const rmBtn = doc.createElement('button');
    rmBtn.type = 'button';
    rmBtn.className = 'shared-post-remove';
    rmBtn.setAttribute('aria-label', 'Remove shared post');
    rmBtn.textContent = '×';
    rmBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      onRemove();
    });
    card.appendChild(rmBtn);
  } else if (sp.url) {
    const link = doc.createElement('a');
    link.className = 'shared-post-link';
    link.href = sp.url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.setAttribute('aria-label', 'Open original post');
    link.title = 'Open original post';
    link.textContent = '↗';
    link.addEventListener('click', (e) => e.stopPropagation());
    card.appendChild(link);
  }

  return card;
}

export function normalizeTurnMedia(msg) {
  if (Array.isArray(msg?.media) && msg.media.length > 0) {
    return msg.media.filter((m) => m?.url);
  }
  if (msg?.image_url) {
    const clean = String(msg.image_url).split('?')[0].toLowerCase();
    return [{
      url: msg.image_url,
      type: clean.endsWith('.mp4') || clean.endsWith('.webm') ? 'video' : 'image',
    }];
  }
  return [];
}

function normalizeToolArgs(raw) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return { args: raw, rawArgs: null };
  }
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed.startsWith('{')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return { args: parsed, rawArgs: null };
        }
      } catch {
        // Keep raw string when args is key=val or truncated live preview
      }
    }
    return { args: {}, rawArgs: raw };
  }
  return { args: {}, rawArgs: null };
}

/**
 * Pair persisted call/response tool_calls records (e.g., _build_tool_calls_pair) into single entries.
 */
export function pairToolCalls(toolCalls = []) {
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) return [];
  const paired = [];
  const byId = new Map();

  for (const tc of toolCalls) {
    if (!tc || typeof tc !== 'object') continue;
    const type = tc.type;
    const isResult = type === 'response' || type === 'result';

    if (!isResult) {
      const { args, rawArgs } = normalizeToolArgs(tc.args);
      const rawResponse = tc.response ?? tc.content ?? tc.output ?? null;
      const entry = {
        id: String(tc.id || ''),
        name: String(tc.name || 'tool'),
        args,
        rawArgs,
        response: rawResponse === null ? null : String(rawResponse),
        status: String(tc.status || ''),
        duration: tc.duration ?? null,
      };
      paired.push(entry);
      if (entry.id) {
        byId.set(entry.id, entry);
      }
      continue;
    }

    const resId = String(tc.id || '');
    const resName = String(tc.name || 'tool');
    const resText = String(tc.response ?? tc.content ?? tc.output ?? '');

    if (resId && byId.has(resId)) {
      byId.get(resId).response = resText;
      if (tc.status) byId.get(resId).status = String(tc.status);
      if (tc.duration !== undefined && tc.duration !== null) byId.get(resId).duration = tc.duration;
      continue;
    }

    let matched = null;
    for (let i = paired.length - 1; i >= 0; i -= 1) {
      if (paired[i].name === resName && paired[i].response === null) {
        matched = paired[i];
        break;
      }
    }
    if (matched) {
      matched.response = resText;
      if (tc.status) matched.status = String(tc.status);
      if (tc.duration !== undefined && tc.duration !== null) matched.duration = tc.duration;
    } else {
      paired.push({
        id: resId,
        name: resName,
        args: {},
        rawArgs: null,
        response: resText,
        status: String(tc.status || ''),
        duration: tc.duration ?? null,
      });
    }
  }

  return paired.map((entry) => ({
    ...entry,
    response: entry.response ?? '',
  }));
}

/**
 * Parse search_music tool output into structured discovery cards.
 */
export function parseMusicDiscoveryItems(toolCalls = []) {
  const sourceCalls =
    Array.isArray(toolCalls) && toolCalls.some((tc) => tc?.type === 'response' || tc?.type === 'result')
      ? pairToolCalls(toolCalls)
      : toolCalls;
  const cards = [];
  for (const tc of sourceCalls) {
    if (tc?.name !== 'search_music') continue;
    const raw = String(tc.response || '');
    if (!raw || raw.startsWith('No music results')) continue;
    const blocks = raw.split(/\n{2,}/).filter((b) => b.trim().startsWith('•'));
    for (const block of blocks) {
      const lines = block.split('\n').map((l) => l.trim());
      const title = (lines[0] || '').replace(/^•\s*/, '').trim();
      let details = '';
      let url = '';
      let source = '';
      for (const line of lines.slice(1)) {
        if (line.startsWith('Details:')) details = line.slice(8).trim();
        else if (line.startsWith('Link:')) url = line.slice(5).trim();
        else if (line.startsWith('Source:')) source = line.slice(7).trim();
      }
      if (title) {
        cards.push({ title, details, url, source });
      }
    }
  }
  return cards;
}

function makeActionBtn(label, svg, className = '', onClick) {
  const doc = globalThis.document;
  const btn = doc.createElement('button');
  btn.type = 'button';
  btn.className = ['action-icon-btn', className].filter(Boolean).join(' ');
  btn.setAttribute('aria-label', label);
  btn.title = label;
  btn.innerHTML = svg;
  if (typeof onClick === 'function') {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      onClick(btn);
    });
  }
  return btn;
}

function splitDialogueQuotesInTextNode(textNode) {
  const doc = globalThis.document;
  const text = textNode.nodeValue || '';
  const quoteRe = /"([^"\n]+)"|“([^”\n]+)”/g;
  if (!quoteRe.test(text) || !textNode.parentNode) return;
  quoteRe.lastIndex = 0;

  const frag = doc.createDocumentFragment();
  let lastIdx = 0;
  for (const match of text.matchAll(quoteRe)) {
    if (match.index > lastIdx) {
      frag.appendChild(doc.createTextNode(text.slice(lastIdx, match.index)));
    }
    const span = doc.createElement('span');
    span.className = 'dialogue-quote';
    span.textContent = match[0];
    frag.appendChild(span);
    lastIdx = match.index + match[0].length;
  }
  if (lastIdx < text.length) {
    frag.appendChild(doc.createTextNode(text.slice(lastIdx)));
  }
  textNode.parentNode.replaceChild(frag, textNode);
}

export function highlightQuotedDialogue(rootEl) {
  if (!rootEl) return;
  const walk = (node) => {
    if (!node) return;
    if (node.nodeType === 1) {
      const tag = node.tagName?.toLowerCase?.();
      if (
        tag === 'pre' ||
        tag === 'code' ||
        tag === 'a' ||
        tag === 'button' ||
        tag === 'textarea' ||
        tag === 'details' ||
        tag === 'summary' ||
        node.classList?.contains?.('antigravity-logs-container')
      ) {
        return;
      }
      for (const child of [...node.childNodes]) {
        walk(child);
      }
    } else if (node.nodeType === 3) {
      splitDialogueQuotesInTextNode(node);
    }
  };
  for (const child of [...rootEl.childNodes]) {
    walk(child);
  }
}

const _SPECIAL_FENCE_RE = /```(sanctuary-plan|sanctuary-widget)[ \t]*\r?\n([\s\S]*?)```/gi;
const _WIDGET_IFRAMES = new Set();
let _widgetResizeListenerBound = false;

function ensureWidgetResizeListener() {
  if (_widgetResizeListenerBound || typeof globalThis.window?.addEventListener !== 'function') {
    return;
  }
  _widgetResizeListenerBound = true;
  globalThis.window.addEventListener('message', (event) => {
    // Sandboxed iframes without allow-same-origin emit opaque origin "null"
    if (event.origin !== 'null') return;
    const data = event.data;
    if (!data || data.type !== 'sanctuary-widget-resize') return;
    const rawHeight = Number(data.height);
    if (!Number.isFinite(rawHeight) || rawHeight <= 0) return;
    for (const iframe of [..._WIDGET_IFRAMES]) {
      if (!iframe.isConnected) {
        _WIDGET_IFRAMES.delete(iframe);
        continue;
      }
      if (event.source && iframe.contentWindow === event.source) {
        iframe.style.height = `${Math.min(900, Math.max(120, Math.ceil(rawHeight)))}px`;
        break;
      }
    }
  });
}

function splitSpecialFenceSegments(rawText) {
  const source = String(rawText || '');
  if (!source.includes('```sanctuary-')) return null;
  _SPECIAL_FENCE_RE.lastIndex = 0;
  const segments = [];
  let cursor = 0;
  for (const match of source.matchAll(_SPECIAL_FENCE_RE)) {
    if (match.index > cursor) {
      const prose = source.slice(cursor, match.index).trim();
      if (prose) segments.push({ kind: 'markdown', content: prose });
    }
    const fenceKind = match[1].toLowerCase() === 'sanctuary-plan' ? 'plan' : 'widget';
    segments.push({ kind: fenceKind, content: (match[2] || '').trim() });
    cursor = match.index + match[0].length;
  }
  if (segments.length === 0) return null;
  if (cursor < source.length) {
    const tail = source.slice(cursor).trim();
    if (tail) segments.push({ kind: 'markdown', content: tail });
  }
  return segments;
}

function renderMarkdownSegmentInto(element, rawText) {
  const doc = globalThis.document;
  if (typeof globalThis.marked?.parse === 'function') {
    try {
      element.innerHTML = globalThis.marked.parse(rawText);
      if (typeof globalThis.hljs?.highlightElement === 'function' && typeof element.querySelectorAll === 'function') {
        for (const block of element.querySelectorAll('pre code')) {
          try {
            globalThis.hljs.highlightElement(block);
          } catch {
            // Keep unhighlighted code block if language grammar fails.
          }
        }
      }
      highlightQuotedDialogue(element);
      return;
    } catch {
      // Fall through to plain paragraph nodes
    }
  }
  const paragraphs = String(rawText || '').split(/\n{2,}/);
  const nodes = paragraphs.map((chunk) => {
    const p = doc.createElement('p');
    p.textContent = chunk;
    return p;
  });
  element.replaceChildren(...nodes);
  highlightQuotedDialogue(element);
}

function createSanctuaryPlanCard(doc, planMarkdown, msg, ctx = {}) {
  const card = doc.createElement('div');
  card.className = 'sanctuary-plan-card';
  card.setAttribute('role', 'region');
  card.setAttribute('aria-label', 'Implementation Plan');
  card.style.cssText = 'margin: 10px 0; border: 1px solid var(--border-color, rgba(255,255,255,0.14)); border-radius: 12px; background: rgba(255,255,255,0.03); overflow: hidden;';

  const details = doc.createElement('details');
  details.className = 'sanctuary-plan-details';
  details.open = true;

  const summary = doc.createElement('summary');
  summary.className = 'sanctuary-plan-summary';
  summary.style.cssText = 'list-style: none; display: flex; align-items: center; gap: 8px; padding: 10px 14px; cursor: pointer; font-weight: 600;';

  const chevron = doc.createElement('span');
  chevron.className = 'ag-item-chevron';
  chevron.setAttribute('aria-hidden', 'true');
  chevron.innerHTML = CHEVRON_DOWN_SVG;

  const label = doc.createElement('span');
  label.className = 'sanctuary-plan-title';
  label.textContent = 'Implementation Plan';

  summary.append(chevron, label);

  const body = doc.createElement('div');
  body.className = 'sanctuary-plan-body';
  body.style.cssText = 'padding: 0 14px 12px 14px; border-top: 1px solid rgba(255,255,255,0.08);';
  renderMarkdownSegmentInto(body, planMarkdown);

  details.append(summary, body);
  card.appendChild(details);

  const actions = doc.createElement('div');
  actions.className = 'sanctuary-plan-actions';
  actions.style.cssText = 'display: flex; justify-content: flex-end; gap: 8px; padding: 8px 14px; border-top: 1px solid rgba(255,255,255,0.08);';

  const reviseBtn = doc.createElement('button');
  reviseBtn.type = 'button';
  reviseBtn.className = 'edit-btn edit-cancel-btn plan-revise-btn';
  reviseBtn.textContent = 'Revise';
  reviseBtn.addEventListener('click', () => ctx.onRevisePlan?.(planMarkdown, msg));

  const proceedBtn = doc.createElement('button');
  proceedBtn.type = 'button';
  proceedBtn.className = 'edit-btn edit-save-btn plan-proceed-btn';
  proceedBtn.textContent = 'Proceed';
  proceedBtn.addEventListener('click', () => ctx.onProceedPlan?.(planMarkdown, msg));

  actions.append(reviseBtn, proceedBtn);
  card.appendChild(actions);
  return card;
}

function createSanctuaryWidgetEmbed(doc, widgetHtml) {
  ensureWidgetResizeListener();
  const iframe = doc.createElement('iframe');
  iframe.className = 'sanctuary-widget-frame';
  iframe.setAttribute('sandbox', 'allow-scripts');
  iframe.setAttribute('loading', 'lazy');
  iframe.setAttribute('title', 'Interactive Sanctuary widget');
  iframe.style.cssText = 'width: 100%; height: 260px; border: 1px solid var(--border-color, rgba(255,255,255,0.14)); border-radius: 12px; margin: 8px 0; background: transparent;';
  iframe.srcdoc = [
    '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1.0">',
    '<style>:root{--bg-color:#12131a;--card-bg:#1a1c26;--text-primary:#f0f2f8;--text-secondary:#a5acc4;--primary-accent:#9b7bff;--border-color:rgba(255,255,255,0.14);color-scheme:dark;}*{box-sizing:border-box;}body{margin:0;padding:12px;font-family:system-ui,-apple-system,sans-serif;background:var(--card-bg);color:var(--text-primary);}</style>',
    '</head><body>',
    widgetHtml,
    "<script>(function(){var post=function(){parent.postMessage({type:'sanctuary-widget-resize',height:document.documentElement.scrollHeight},'*');};window.addEventListener('load',post);if(typeof ResizeObserver==='function'){new ResizeObserver(post).observe(document.documentElement);}})();<\/script>",
    '</body></html>',
  ].join('');
  _WIDGET_IFRAMES.add(iframe);
  return iframe;
}

function renderMarkdownInto(element, rawText, msg = null, ctx = {}) {
  const segments = splitSpecialFenceSegments(rawText);
  if (!segments) {
    renderMarkdownSegmentInto(element, rawText);
    return;
  }
  const doc = globalThis.document;
  const nodes = [];
  for (const seg of segments) {
    if (seg.kind === 'plan') {
      nodes.push(createSanctuaryPlanCard(doc, seg.content, msg, ctx));
    } else if (seg.kind === 'widget') {
      nodes.push(createSanctuaryWidgetEmbed(doc, seg.content));
    } else {
      const wrap = doc.createElement('div');
      wrap.className = 'markdown-segment';
      renderMarkdownSegmentInto(wrap, seg.content);
      nodes.push(wrap);
    }
  }
  element.replaceChildren(...nodes);
}

const FILE_TYPE_BADGE_MAP = Object.freeze({
  js: 'JS',
  mjs: 'JS',
  cjs: 'JS',
  ts: 'TS',
  tsx: 'TS',
  py: 'PY',
  css: 'CSS',
  json: 'JSON',
  md: 'MD',
  html: 'HTML',
  htm: 'HTML',
  sh: 'SH',
  ps1: 'SH',
});

function resolveFileTypeBadge(target) {
  const raw = String(target || '').trim().split(/[?#]/)[0];
  const dotIdx = raw.lastIndexOf('.');
  if (dotIdx < 0) return '';
  const ext = raw.slice(dotIdx + 1).toLowerCase();
  return FILE_TYPE_BADGE_MAP[ext] || '';
}

function summarizeTerminalCommand(rawCmd) {
  let cmd = String(rawCmd || '').replace(/\s*2>\/dev\/null\b/g, '').replace(/\s+/g, ' ').trim();
  if (!cmd) return 'command';
  cmd = cmd.replace(/^&\s+/, '');
  cmd = cmd.replace(/(?:[A-Za-z]:)?(?:[\\/][^\\/\s]+)*[\\/]python(?:\.exe)?\b/gi, 'python');
  const segments = cmd.split(/\s*(?:;|&&)\s*/).map((s) => s.trim()).filter(Boolean);
  const nonCdSegments = segments.filter((s) => !/^(?:cd|Set-Location|Push-Location)\b/i.test(s));
  const primary = nonCdSegments[0] || segments[0] || cmd;
  if (primary.length <= 48 && !primary.includes('|')) {
    return primary;
  }

  const pipeFirst = primary.split(/\s+\|\s+/)[0].trim();

  if (/^(?:Select-String|rg|grep)\b/i.test(pipeFirst)) {
    const patMatch = pipeFirst.match(/(?:-Pattern|-e)\s+["']([^"']{1,64})["']/i)
      || pipeFirst.match(/^(?:rg|grep)\s+(?:-[A-Za-z]+\s+)*["']([^"']{1,64})["']/i);
    let pathMatch = pipeFirst.match(/-Path\s+["']?([^\s"';|]+)["']?/i);
    if (!pathMatch && patMatch) {
      const afterPat = pipeFirst.slice((patMatch.index || 0) + patMatch[0].length).trim();
      const trailMatch = afterPat.match(/^["']?([^\s"'-][^\s"']*)["']?/);
      if (trailMatch) pathMatch = trailMatch;
    }
    const rawPat = patMatch ? patMatch[1].replace(/\\\\\|/g, '|').replace(/\\\|/g, '|') : '';
    const pat = rawPat.length > 32 ? `${rawPat.slice(0, 29)}…` : rawPat;
    const fileHint = pathMatch ? formatToolTargetPath(pathMatch[1]) : '';
    if (pat) {
      return fileHint ? `search "${pat}" in ${fileHint}` : `search "${pat}"`;
    }
    return fileHint ? `search ${fileHint}` : 'search files';
  }

  const sedMatch = pipeFirst.match(/^sed\s+-n\s+["']?(\d+)(?:,(\d+))?p["']?\s+["']?([^\s"';|]+)["']?/i);
  if (sedMatch) {
    const start = sedMatch[1];
    const end = sedMatch[2];
    const fileHint = formatToolTargetPath(sedMatch[3]);
    return `read ${fileHint}${end ? ` #L${start}-${end}` : ` #L${start}`}`;
  }

  if (/^(?:Get-ChildItem|ls|dir)\b/i.test(pipeFirst)) {
    const rest = pipeFirst.replace(/^(?:Get-ChildItem|ls|dir)\s*/i, '').replace(/^(?:-Path\s+)/i, '').trim();
    const firstToken = (rest.split(/\s+/)[0] || '').replace(/^["']|["']$/g, '');
    const base = firstToken && !firstToken.startsWith('-') ? formatToolTargetPath(firstToken) : 'workspace';
    return `inspect ${base}`;
  }

  if (/^(?:Get-Content|cat|head|tail)\b/i.test(pipeFirst)) {
    const rest = pipeFirst.replace(/^(?:Get-Content|cat|head|tail)\s*/i, '').replace(/^(?:-Path\s+)/i, '').trim();
    const firstToken = (rest.split(/\s+/)[0] || '').replace(/^["']|["']$/g, '');
    const base = firstToken && !firstToken.startsWith('-') ? formatToolTargetPath(firstToken) : 'file';
    return `read ${base}`;
  }

  if (/^python\s+-c\b/i.test(pipeFirst)) {
    return 'python inline script';
  }

  const compact = pipeFirst.replace(/\s+/g, ' ').trim();
  return compact.length > 56 ? `${compact.slice(0, 53)}…` : compact;
}

function formatToolTargetPath(rawPath) {
  const value = String(rawPath || '').trim();
  if (!value) return '';
  if (value.startsWith('http://') || value.startsWith('https://')) {
    try {
      const parsed = new URL(value);
      const pathname = parsed.pathname === '/' ? '' : parsed.pathname;
      return `${parsed.hostname}${pathname}`;
    } catch {
      return value;
    }
  }
  const parts = value.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || value;
}

function parseToolResultCount(toolName, responseText) {
  if (!responseText) return null;
  const trimmed = String(responseText).trim();
  if (!trimmed || trimmed === 'No search results found.' || trimmed === 'No search results found' || trimmed.startsWith('Error')) {
    return trimmed ? 0 : null;
  }
  const foundFilesMatch = /^Found\s+(\d+)\s+file\(s\)/i.exec(trimmed);
  if (foundFilesMatch) {
    return Number(foundFilesMatch[1]);
  }
  if (/^No files found\b/i.test(trimmed)) {
    return 0;
  }
  try {
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed.length;
      if (Array.isArray(parsed?.results)) return parsed.results.length;
      if (Array.isArray(parsed?.matches)) return parsed.matches.length;
    }
  } catch {
    // Fallback to text heuristics
  }
  if (toolName === 'web_search' || toolName === 'google_search' || toolName === 'search_music') {
    return trimmed.split(/\n{2,}/).filter((b) => b.trim().length > 0).length;
  }
  const lines = trimmed.split('\n').filter((l) => l.trim().length > 0);
  if (lines.length > 0 && lines.length < 50) {
    return lines.length;
  }
  return null;
}

function formatToolLogDescriptor(tool, { live = false } = {}) {
  const rawName = String(tool?.name || 'tool');
  const name = rawName.replace(/^(?:openhands|antigravity):/i, '');
  const args = tool?.args || {};
  let category = 'other';
  let icon = getLogIconSvg('gear');
  let action = 'Ran';
  let target = name;
  let suffix = '';
  let isMutation = true;

  if (name === 'file_editor') {
    const cmd = String(args.command || 'view').toLowerCase();
    target = formatToolTargetPath(args.path || '') || name;
    if (cmd === 'view') {
      category = 'file';
      icon = getLogIconSvg('file');
      action = live && (!tool.status || tool.status === 'running') ? 'Reading' : 'Analyzed';
      isMutation = false;
      if (Array.isArray(args.view_range) && args.view_range.length >= 2) {
        suffix = ` #L${args.view_range[0]}-${args.view_range[1]}`;
      }
    } else {
      category = 'edit';
      icon = getLogIconSvg('edit');
      const isCreate = cmd === 'create';
      action = live && (!tool.status || tool.status === 'running')
        ? (isCreate ? 'Writing' : 'Editing')
        : (isCreate ? 'Created' : 'Edited');
      const added = args.file_text
        ? String(args.file_text).split('\n').length
        : (args.new_str
          ? String(args.new_str).split('\n').length
          : Number(args.file_lines || args.new_lines || 0));
      const removed = args.old_str
        ? String(args.old_str).split('\n').length
        : Number(args.old_lines || 0);
      if (added || removed) suffix = ` +${added} -${removed}`;
      else if (args.insert_line) suffix = ` @L${args.insert_line}`;
    }
  } else if (name === 'read_file' || name === 'view_file' || name === 'read_webpage') {
    category = 'file';
    icon = name === 'read_webpage' ? getLogIconSvg('webpage') : getLogIconSvg('file');
    action = live && (!tool.status || tool.status === 'running') ? 'Reading' : 'Analyzed';
    target = formatToolTargetPath(args.path || args.AbsolutePath || args.url || '') || (tool.rawArgs || name);
    isMutation = false;
    const start = args.StartLine || args.start_line || '';
    const end = args.EndLine || args.end_line || '';
    if (start && end) suffix = ` #L${start}-${end}`;
    else if (start) suffix = ` #L${start}`;
  } else if (name === 'glob') {
    category = 'folder';
    icon = getLogIconSvg('folder');
    action = live && (!tool.status || tool.status === 'running') ? 'Finding' : 'Matched';
    const pat = String(args.pattern || '*').trim();
    const pathHint = args.path ? ` in ${formatToolTargetPath(args.path)}` : '';
    target = `${pat}${pathHint}`;
    isMutation = false;
    if (tool.response) {
      const count = parseToolResultCount(name, tool.response);
      if (count !== null) {
        suffix = ` ${count} file${count === 1 ? '' : 's'}`;
      }
    }
  } else if (name === 'get_workspace_structure' || name === 'list_dir' || name === 'find_files') {
    category = 'folder';
    icon = getLogIconSvg('folder');
    action = live && (!tool.status || tool.status === 'running') ? 'Exploring' : 'Explored';
    target = args.path || args.DirectoryPath || args.pattern || 'workspace';
    isMutation = false;
  } else if (name === 'grep') {
    category = 'search';
    icon = getLogIconSvg('search');
    action = live && (!tool.status || tool.status === 'running') ? 'Searching' : 'Searched';
    const cleanPat = String(args.pattern || args.query || tool.rawArgs || '').replace(/\\\\\|/g, '|').replace(/\\\|/g, '|');
    const shortPat = cleanPat.length > 36 ? `${cleanPat.slice(0, 33)}…` : cleanPat;
    const scopeParts = [];
    if (args.path) scopeParts.push(`in ${formatToolTargetPath(args.path)}`);
    if (args.include) scopeParts.push(`(${args.include})`);
    const scope = scopeParts.length ? ` ${scopeParts.join(' ')}` : '';
    target = shortPat ? `"${shortPat}"${scope}` : (scope.trim() || 'files');
    isMutation = false;
    if (tool.response) {
      const count = parseToolResultCount(name, tool.response);
      if (count !== null) {
        suffix = ` ${count} file${count === 1 ? '' : 's'}`;
      }
    }
  } else if (
    name === 'search_codebase' ||
    name === 'grep_search' ||
    name === 'web_search' ||
    name === 'google_search' ||
    name === 'search_github' ||
    name === 'search_arxiv' ||
    name === 'search_hacker_news' ||
    name === 'search_music'
  ) {
    category = 'search';
    icon = getLogIconSvg('search');
    action = live && (!tool.status || tool.status === 'running') ? 'Searching' : 'Searched';
    target = String(args.query || args.keyword || args.Query || tool.rawArgs || name);
    isMutation = false;
    if (tool.response) {
      const count = parseToolResultCount(name, tool.response);
      if (count !== null) {
        suffix = ` ${count} result${count === 1 ? '' : 's'}`;
      }
    }
  } else if (name === 'invoke_skill') {
    category = 'file';
    icon = getLogIconSvg('file');
    action = live && (!tool.status || tool.status === 'running') ? 'Loading skill' : 'Loaded skill';
    target = String(args.name || args.skill || 'skill');
    isMutation = false;
  } else if (name === 'task_tracker') {
    category = 'other';
    icon = getLogIconSvg('file');
    action = live && (!tool.status || tool.status === 'running') ? 'Planning' : 'Updated tasks';
    target = args.active_task
      ? `${args.active_task}${args.task_count ? ` (${args.task_count})` : ''}`
      : (args.task_count ? `${args.task_count} tasks` : 'task checklist');
    isMutation = false;
  } else if (name === 'update_plan_step') {
    category = 'other';
    icon = getLogIconSvg('file');
    action = 'Plan step';
    target = args.step !== undefined ? `#${args.step} → ${args.status || 'updated'}` : String(args.status || 'updated');
    isMutation = false;
  } else if (name === 'http_probe') {
    category = 'file';
    icon = getLogIconSvg('webpage');
    action = live && (!tool.status || tool.status === 'running') ? 'Probing' : 'Probed';
    target = `${String(args.method || 'GET').toUpperCase()} ${formatToolTargetPath(args.url || '') || 'endpoint'}`;
    isMutation = false;
  } else if (name === 'ask_user') {
    category = 'other';
    icon = getLogIconSvg('gear');
    action = live && (!tool.status || tool.status === 'running') ? 'Asking' : 'Asked';
    const q = String(args.question || 'user').trim();
    target = q.length > 56 ? `${q.slice(0, 53)}…` : q;
    isMutation = false;
  } else if (name === 'think') {
    category = 'other';
    icon = getLogIconSvg('gear');
    action = 'Thought';
    target = 'reasoning step';
    isMutation = false;
  } else if (name === 'finish') {
    category = 'other';
    icon = getLogIconSvg('gear');
    action = 'Finished';
    target = 'response';
    isMutation = false;
  } else if (name === 'tune_feed_algorithm') {
    category = 'edit';
    icon = getLogIconSvg('edit');
    action = live && (!tool.status || tool.status === 'running') ? 'Tuning' : 'Tuned';
    target = args.preset ? `feed algorithm (${args.preset})` : 'feed algorithm';
    isMutation = false;
  } else if (name === 'browser_action') {
    const bAct = String(args.action || 'snapshot').toLowerCase();
    category = 'file';
    icon = getLogIconSvg('webpage');
    isMutation = ['click', 'type', 'select', 'press'].includes(bAct);
    action = live && (!tool.status || tool.status === 'running') ? 'Browsing' : 'Browser';
    const detailPart = args.ref ? `[${args.ref}]` : (formatToolTargetPath(args.url || '') || args.text || '');
    target = detailPart ? `${bAct} ${detailPart}` : bAct;
  } else if (name === 'consult_cloud') {
    category = 'search';
    icon = getLogIconSvg('webpage');
    action = live && (!tool.status || tool.status === 'running') ? 'Consulting' : 'Consulted';
    target = args.tier === 'deep' ? 'Cloud Model (deep)' : 'Cloud Model';
    isMutation = false;
  } else if (name === 'task') {
    category = 'other';
    icon = getLogIconSvg('gear');
    action = live && (!tool.status || tool.status === 'running') ? 'Subagent' : 'Delegated';
    const subType = String(args.subagent_type || 'subagent').trim();
    const desc = String(args.description || '').trim();
    target = desc ? `${subType}: ${desc}` : subType;
    isMutation = false;
  } else if (name === 'set_working_folder') {
    category = 'folder';
    icon = getLogIconSvg('folder');
    action = live && (!tool.status || tool.status === 'running') ? 'Setting' : 'Set folder';
    target = formatToolTargetPath(args.path || args.folder || args.directory || '') || 'workspace';
    isMutation = true;
  } else if (name === 'delegate_coding') {
    category = 'other';
    icon = getLogIconSvg('gear');
    action = live && (!tool.status || tool.status === 'running') ? 'Building' : 'Built';
    const rawTarget = formatToolTargetPath(args.path || '') || String(args.task || 'coding task');
    target = rawTarget.length > 48 ? `${rawTarget.slice(0, 45)}...` : rawTarget;
    isMutation = true;
  } else if (name === 'write_file' || name === 'write_to_file') {
    category = 'edit';
    icon = getLogIconSvg('edit');
    action = live && (!tool.status || tool.status === 'running') ? 'Writing' : (args.Overwrite ? 'Edited' : 'Created');
    target = formatToolTargetPath(args.path || args.TargetFile || '') || name;
    const contentVal = String(args.content || args.CodeContent || '');
    if (contentVal) suffix = ` +${contentVal.split('\n').length} -0`;
  } else if (name === 'edit_file' || name === 'replace_in_file' || name === 'replace_file_content' || name === 'multi_replace_file_content') {
    category = 'edit';
    icon = getLogIconSvg('edit');
    action = live && (!tool.status || tool.status === 'running') ? 'Editing' : 'Edited';
    target = formatToolTargetPath(args.path || args.TargetFile || '') || name;
    const replText = args.replacement ?? args.ReplacementContent ?? '';
    const tgtText = args.target ?? args.TargetContent ?? '';
    const added = replText ? String(replText).split('\n').length : 0;
    const removed = tgtText ? String(tgtText).split('\n').length : 0;
    if (added || removed) suffix = ` +${added} -${removed}`;
  } else if (name === 'terminal' || name === 'run_shell_command' || name === 'run_command') {
    category = 'command';
    icon = getLogIconSvg('command');
    action = live && (!tool.status || tool.status === 'running') ? 'Running' : 'Ran';
    const cmd = String(args.command || args.CommandLine || tool.rawArgs || name);
    target = summarizeTerminalCommand(cmd);
  } else if (tool.rawArgs) {
    const trimmedArgs = String(tool.rawArgs).trim();
    target = `${name}(${trimmedArgs.length > 44 ? `${trimmedArgs.slice(0, 41)}...` : trimmedArgs})`;
  }

  const isRunning = Boolean(live && (!tool.status || tool.status === 'running'));
  const respTrim = String(tool.response || '').trim();
  const isErrorResp =
    tool.status === 'failed'
    || tool.status === 'error'
    || respTrim.startsWith('Error:')
    || respTrim.startsWith('Error executing tool:')
    || respTrim.startsWith('[Tool Error]');
  if (isErrorResp) {
    action = 'Failed';
    if (category === 'edit') suffix = '';
  } else if (live && tool.status === 'cancelled') {
    action = 'Stopped';
  }
  if (live && tool.duration) {
    suffix = `${suffix} (${tool.duration}s)`.trimStart();
  }

  let argsBlock = '';
  if (args && Object.keys(args).length > 0) {
    argsBlock = `Parameters:\n${JSON.stringify(args, null, 2)}\n\n`;
  } else if (tool.rawArgs) {
    argsBlock = `Parameters:\n${tool.rawArgs}\n\n`;
  }
  const responseBody = tool.response || (isRunning ? 'Running...' : 'No response data');
  const fileBadge = (category === 'file' || category === 'edit') ? resolveFileTypeBadge(target) : '';

  return {
    id: tool.id || '',
    category,
    icon,
    fileBadge,
    action,
    target,
    suffix,
    isMutation,
    isRunning,
    detail: `${argsBlock}Response:\n${responseBody}`,
  };
}

function createToolEntryDetails(doc, descriptor) {
  const details = doc.createElement('details');
  details.className = `antigravity-log-entry${descriptor.isMutation ? ' mutation-item' : ''}${descriptor.isRunning ? ' is-running' : ''}`;
  if (descriptor.id) details.dataset.callId = descriptor.id;

  const summary = doc.createElement('summary');
  summary.className = 'antigravity-log-item';

  const chevron = doc.createElement('span');
  chevron.className = 'ag-item-chevron';
  chevron.setAttribute('aria-hidden', 'true');
  chevron.innerHTML = CHEVRON_DOWN_SVG;

  const actionEl = doc.createElement('span');
  actionEl.className = 'ag-log-action';
  actionEl.textContent = descriptor.action;

  const targetEl = doc.createElement('span');
  targetEl.className = 'ag-log-target';
  targetEl.textContent = descriptor.target;

  const showGenericIcon = !(descriptor.fileBadge && descriptor.action === 'Analyzed');
  if (showGenericIcon) {
    const iconEl = doc.createElement('span');
    iconEl.className = 'ag-log-icon';
    iconEl.setAttribute('aria-hidden', 'true');
    iconEl.innerHTML = descriptor.icon;
    summary.append(actionEl, iconEl);
  } else {
    summary.append(actionEl);
  }

  if (descriptor.fileBadge) {
    const badgeEl = doc.createElement('span');
    badgeEl.className = 'ag-filetype-badge';
    badgeEl.dataset.ext = descriptor.fileBadge.toLowerCase();
    badgeEl.textContent = descriptor.fileBadge;
    summary.appendChild(badgeEl);
  }

  summary.appendChild(targetEl);

  if (descriptor.suffix) {
    const suffixEl = doc.createElement('span');
    suffixEl.className = 'ag-log-suffix';
    suffixEl.textContent = descriptor.suffix;
    summary.appendChild(suffixEl);
  }

  summary.appendChild(chevron);

  const detailWrap = doc.createElement('div');
  detailWrap.className = 'antigravity-log-detail';
  const pre = doc.createElement('pre');
  const code = doc.createElement('code');
  code.textContent = descriptor.detail;
  pre.appendChild(code);
  detailWrap.appendChild(pre);

  details.append(summary, detailWrap);
  return details;
}

function buildExploreGroupSummaryText(explorationItems) {
  const uniqueFiles = new Set();
  const uniqueFolders = new Set();
  let searchesCount = 0;

  for (const item of explorationItems) {
    if (item.category === 'file') uniqueFiles.add(item.target);
    else if (item.category === 'folder') uniqueFolders.add(item.target);
    else if (item.category === 'search') searchesCount += 1;
  }

  const parts = [];
  if (uniqueFiles.size > 0) parts.push(`${uniqueFiles.size} file${uniqueFiles.size === 1 ? '' : 's'}`);
  if (uniqueFolders.size > 0) parts.push(`${uniqueFolders.size} folder${uniqueFolders.size === 1 ? '' : 's'}`);
  if (searchesCount > 0) parts.push(`${searchesCount} search${searchesCount === 1 ? '' : 'es'}`);
  return parts.length > 0 ? `Explored ${parts.join(', ')}` : 'Explored workspace';
}

function ensureActivityLogsCard(doc, bubble) {
  let container = bubble.querySelector('.antigravity-logs-container');
  if (!container) {
    container = doc.createElement('div');
    container.className = 'antigravity-logs-container';
    bubble.appendChild(container);
  }

  let card = container.querySelector('details.antigravity-logs-card');
  if (!card) {
    card = doc.createElement('details');
    card.className = 'antigravity-logs-card';

    const summary = doc.createElement('summary');
    summary.className = 'antigravity-logs-header';

    const chevron = doc.createElement('span');
    chevron.className = 'ag-header-chevron';
    chevron.setAttribute('aria-hidden', 'true');
    chevron.innerHTML = CHEVRON_DOWN_SVG;

    const timerIcon = doc.createElement('span');
    timerIcon.className = 'ag-timer-icon';
    timerIcon.setAttribute('aria-hidden', 'true');
    timerIcon.innerHTML = getLogIconSvg('timer');

    const label = doc.createElement('span');
    label.className = 'ag-timer-text';

    summary.append(chevron, timerIcon, label);

    const body = doc.createElement('div');
    body.className = 'antigravity-logs-body';

    card.append(summary, body);
    container.replaceChildren(card);
  }

  return {
    card,
    label: card.querySelector('.ag-timer-text'),
    body: card.querySelector('.antigravity-logs-body'),
  };
}

function populateLogsBody(doc, body, descriptors) {
  const explorationItems = descriptors.filter((item) => !item.isMutation);
  const mutationItems = descriptors.filter((item) => item.isMutation);
  const nodes = [];

  if (explorationItems.length > 2) {
    const exploreDetails = doc.createElement('details');
    exploreDetails.className = 'antigravity-explore-container';

    const exploreSummary = doc.createElement('summary');
    exploreSummary.className = 'antigravity-explore-header';

    const exploreChevron = doc.createElement('span');
    exploreChevron.className = 'ag-explore-chevron';
    exploreChevron.setAttribute('aria-hidden', 'true');
    exploreChevron.innerHTML = CHEVRON_DOWN_SVG;

    const exploreText = doc.createElement('span');
    exploreText.className = 'ag-explore-text';
    exploreText.textContent = buildExploreGroupSummaryText(explorationItems);

    exploreSummary.append(exploreChevron, exploreText);

    const exploreBody = doc.createElement('div');
    exploreBody.className = 'antigravity-explore-body';
    for (const item of explorationItems) {
      exploreBody.appendChild(createToolEntryDetails(doc, item));
    }

    exploreDetails.append(exploreSummary, exploreBody);
    nodes.push(exploreDetails);
  } else {
    for (const item of explorationItems) {
      nodes.push(createToolEntryDetails(doc, item));
    }
  }

  for (const item of mutationItems) {
    nodes.push(createToolEntryDetails(doc, item));
  }

  body.replaceChildren(...nodes);
}

/**
 * Render live polling tool activity inside the typing indicator bubble,
 * preserving the card's open/closed toggle state across updates.
 */
export function renderLiveToolLogs(typingBubble, toolCalls = []) {
  if (!typingBubble || !Array.isArray(toolCalls) || toolCalls.length === 0) return;
  const doc = globalThis.document;
  const nextSig = JSON.stringify(toolCalls);
  const { card, label, body } = ensureActivityLogsCard(doc, typingBubble);
  if (card.dataset?.logsSig === nextSig) return;

  const paired = pairToolCalls(toolCalls);
  if (paired.length === 0) return;
  const wasOpen = Boolean(card.open);
  const wasExploreOpen = Boolean(body.querySelector('details.antigravity-explore-container')?.open);
  const countLabel = `${paired.length} tool call${paired.length === 1 ? '' : 's'}`;
  const activePhase = [...toolCalls]
    .reverse()
    .map((t) => String(t?.phase || '').trim())
    .find(Boolean) || '';
  label.textContent = `${activePhase || 'Working'}... · ${countLabel}`;

  const descriptors = paired.map((tool) => formatToolLogDescriptor(tool, { live: true }));
  const openIds = new Set();
  const scrollMap = new Map();
  for (const el of body.querySelectorAll('details.antigravity-log-entry')) {
    const cid = el.dataset?.callId;
    if (!cid) continue;
    if (el.open) openIds.add(cid);
    const preEl = el.querySelector('.antigravity-log-detail pre');
    if (preEl && preEl.scrollTop > 0) {
      scrollMap.set(cid, preEl.scrollTop);
    }
  }
  populateLogsBody(doc, body, descriptors);
  const exploreEl = body.querySelector('details.antigravity-explore-container');
  if (exploreEl && wasExploreOpen) {
    exploreEl.open = true;
  }
  for (const entryEl of body.querySelectorAll('details.antigravity-log-entry')) {
    const cid = entryEl.dataset?.callId;
    if (!cid) continue;
    if (openIds.has(cid)) {
      entryEl.open = true;
    }
    const savedScroll = scrollMap.get(cid);
    if (savedScroll) {
      const preEl = entryEl.querySelector('.antigravity-log-detail pre');
      if (preEl) preEl.scrollTop = savedScroll;
    }
  }
  card.open = wasOpen;
  if (card.dataset) card.dataset.logsSig = nextSig;
}

function renderToolLogsAndMusic(bubble, toolCalls = [], duration = null) {
  const doc = globalThis.document;
  const paired = pairToolCalls(toolCalls);

  if (paired.length > 0) {
    const { card, label, body } = ensureActivityLogsCard(doc, bubble);
    card.open = false;
    const countLabel = `${paired.length} tool call${paired.length === 1 ? '' : 's'}`;
    label.textContent = duration
      ? `Worked for ${duration}s · ${countLabel}`
      : `Activity · ${countLabel}`;

    const descriptors = paired.map((tool) => formatToolLogDescriptor(tool));
    populateLogsBody(doc, body, descriptors);
  }

  const musicItems = parseMusicDiscoveryItems(paired);
  if (musicItems.length > 0) {
    const musicWrap = doc.createElement('div');
    musicWrap.className = 'music-discovery-list';
    for (const track of musicItems) {
      const card = doc.createElement('div');
      card.className = 'music-discovery-card';

      const titleEl = doc.createElement('strong');
      titleEl.className = 'music-discovery-title';
      titleEl.textContent = track.title;
      card.appendChild(titleEl);

      if (track.details) {
        const desc = doc.createElement('p');
        desc.className = 'music-discovery-details';
        desc.textContent = track.details;
        card.appendChild(desc);
      }
      if (track.url && /^https?:\/\//i.test(track.url)) {
        const link = doc.createElement('a');
        link.className = 'music-discovery-link';
        link.href = track.url;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.textContent = track.source ? `Listen (${track.source})` : 'Open Link';
        card.appendChild(link);
      }
      musicWrap.appendChild(card);
    }
    bubble.appendChild(musicWrap);
  }
}

export function buildVoiceCallRow(msg, ctx = {}) {
  const doc = globalThis.document;
  const row = doc.createElement('div');
  row.className = 'message-row voice-call-row';
  row.dataset.role = 'voice-call';
  row.dataset.rawText = msg.text || '';
  row.dataset.timestamp = String(msg.timestamp || '');
  row.dataset.msgId = msg.id || fallbackMsgId();
  row.dataset.contentHash = computeContentHash(msg);

  let parsed = { duration: '0s', turns: [] };
  try {
    parsed = JSON.parse(msg.text || '{}');
  } catch {
    // Keep empty fallback
  }

  const card = doc.createElement('div');
  card.className = 'voice-call-record';

  const header = doc.createElement('div');
  header.className = 'voice-call-record-header';

  const info = doc.createElement('div');
  info.className = 'voice-call-record-info';
  const icon = doc.createElement('div');
  icon.className = 'voice-call-record-icon';
  icon.innerHTML = PHONE_SVG;

  const textBox = doc.createElement('div');
  const title = doc.createElement('h4');
  title.className = 'voice-call-record-title';
  title.textContent = `Voice Call with ${ctx.programName || msg.sender_name || 'Program'}`;
  const meta = doc.createElement('p');
  meta.className = 'voice-call-record-meta';
  const turns = Array.isArray(parsed.turns) ? parsed.turns : [];
  meta.textContent = `Duration: ${parsed.duration || '0s'} • ${turns.length} turn${turns.length !== 1 ? 's' : ''}`;
  textBox.appendChild(title);
  textBox.appendChild(meta);
  info.appendChild(icon);
  info.appendChild(textBox);

  const toggleBtn = doc.createElement('button');
  toggleBtn.type = 'button';
  toggleBtn.className = 'voice-call-record-toggle';
  toggleBtn.textContent = 'Show Transcript';
  toggleBtn.setAttribute('aria-expanded', 'false');

  const transcriptDiv = doc.createElement('div');
  transcriptDiv.className = 'voice-call-record-transcript';
  transcriptDiv.hidden = true;

  for (const turn of turns) {
    const p = doc.createElement('p');
    p.className = 'voice-call-record-turn';
    const speakerSpan = doc.createElement('span');
    speakerSpan.className = `turn-speaker ${turn.speaker}`;
    speakerSpan.textContent = turn.speaker === 'user' ? `${ctx.userName || 'You'}: ` : `${ctx.programName || 'Program'}: `;
    const textSpan = doc.createElement('span');
    textSpan.textContent = String(turn.text || '');
    p.appendChild(speakerSpan);
    p.appendChild(textSpan);
    transcriptDiv.appendChild(p);
  }

  toggleBtn.addEventListener('click', () => {
    transcriptDiv.hidden = !transcriptDiv.hidden;
    toggleBtn.setAttribute('aria-expanded', transcriptDiv.hidden ? 'false' : 'true');
    toggleBtn.textContent = transcriptDiv.hidden ? 'Show Transcript' : 'Hide Transcript';
  });

  header.appendChild(info);
  header.appendChild(toggleBtn);
  card.appendChild(header);

  const hoverActions = doc.createElement('div');
  hoverActions.className = 'voice-call-actions';
  hoverActions.appendChild(
    makeActionBtn('Delete call record', DELETE_SVG, '', () => ctx.onDelete?.(msg, row))
  );
  card.appendChild(hoverActions);
  card.appendChild(transcriptDiv);

  row.appendChild(card);
  return row;
}

function resolveRowAvatarSrc(speakerId, ctx = {}) {
  const sid = String(speakerId || ctx.programId || '').trim();
  if (sid && ctx.hasProgramProfile?.(sid) === false) {
    return DEFAULT_AVATAR_DATA_URI;
  }
  return resolveProgramAvatarUrl(sid, {
    cacheBuster: ctx.getAvatarVersion?.(sid) ?? ctx.cacheBuster,
  }) || DEFAULT_AVATAR_DATA_URI;
}

/**
 * Construct a single Sanctuary chat row with exact 4-slot user/program action symmetry:
 * User bubbles: [Reroll, Edit, Delete, FediverseShareButton]
 * Program bubbles: [Reroll, Edit, Delete, Speak TTS]
 */
export function buildMessageRow(msg, ctx = {}) {
  if (!msg) return null;
  if (msg.role === 'voice-call') {
    return buildVoiceCallRow(msg, ctx);
  }

  const doc = globalThis.document;
  const role = msg.role || 'program';
  const text = String(msg.text || '');
  const fallbackShared = !msg.shared_post && role === 'user' ? parseInlineSharedPostFallback(text) : null;
  const sharedPost = msg.shared_post
    ? normalizeSharedPostCard(msg.shared_post)
    : (fallbackShared?.sharedPost || null);
  const visibleText = sharedPost
    ? String(msg.shared_post ? (msg.user_note ?? '') : (fallbackShared?.userNote ?? ''))
    : text;
  const msgId = msg.id || fallbackMsgId();
  const isMsgTransient = Boolean(msg.isTransient);
  const normalizedMedia = normalizeTurnMedia(msg);

  const row = doc.createElement('div');
  row.className = `message-row ${role}-row`;
  row.dataset.role = role;
  row.dataset.rawText = visibleText;
  row.dataset.imageUrl = normalizedMedia.find((m) => m.type !== 'video')?.url || '';
  row.dataset.toolCalls = JSON.stringify(msg.tool_calls || []);
  row.dataset.timestamp = String(msg.timestamp || '');
  row.dataset.duration = String(msg.duration || '');
  row.dataset.msgId = msgId;
  row.dataset.contentHash = computeContentHash(msg);

  if (role === 'program') {
    const speakerId = msg.sender_id || ctx.programId || '';
    row.dataset.senderId = speakerId;
    const avatarContainer = doc.createElement('div');
    avatarContainer.className = 'avatar-container';

    const avatar = doc.createElement('img');
    avatar.className = 'avatar program-avatar';
    if (speakerId) avatar.setAttribute('data-sender-id', speakerId);
    if (msg.sender_name) avatar.setAttribute('data-name', msg.sender_name);
    avatar.src = resolveRowAvatarSrc(speakerId, ctx);
    avatar.alt = msg.sender_name || 'Program';
    avatar.title = 'View Recent Media';
    avatar.addEventListener('error', () => {
      if (avatar.src !== DEFAULT_AVATAR_DATA_URI) {
        avatar.src = DEFAULT_AVATAR_DATA_URI;
      }
    });
    avatar.addEventListener('click', () => {
      ctx.onOpenAvatarMedia?.(speakerId, msg.sender_name || ctx.programName || speakerId);
    });
    avatarContainer.appendChild(avatar);
    row.appendChild(avatarContainer);
  }

  const bubblesContainer = doc.createElement('div');
  bubblesContainer.className = 'message-bubbles-container';

  const bubblesToCreate = [];
  const isTextEmpty = !visibleText.replace(/[:\s]/g, '').trim();
  if (!isTextEmpty || Boolean(sharedPost) || normalizedMedia.length === 0) {
    bubblesToCreate.push({ type: 'text', content: visibleText });
  }
  if (normalizedMedia.length > 0) {
    bubblesToCreate.push({ type: 'media', content: normalizedMedia });
  }

  let sharedPrompt = msg.prompt || '';
  if (!sharedPrompt && Array.isArray(msg.tool_calls)) {
    const genCall = msg.tool_calls.find((tc) => tc?.type === 'call' && tc?.args?.prompt);
    if (genCall) sharedPrompt = genCall.args.prompt;
  }

  bubblesToCreate.forEach((item, idx) => {
    const isMediaItem = item.type === 'media';
    const mediaList = isMediaItem ? item.content.slice(0, MAX_IMAGES_PER_ROW) : [];
    const isVideo = isMediaItem && mediaList.length === 1 && mediaList[0].type === 'video';
    const bubble = doc.createElement('div');
    bubble.className = `message ${role}${isMediaItem ? ' image-message' : ''}`;
    bubble.dataset.rawText = visibleText;
    bubble.dataset.msgId = msgId;
    if (isMsgTransient) bubble.dataset.isTransient = 'true';

    if (role === 'program') {
      const speakerId = msg.sender_id || ctx.programId || '';
      const theme = ctx.getThemeForProgram?.(speakerId) || ctx.theme;
      if (theme) applyScopedProgramTheme(bubble, theme);
    }

    const shouldAddStandardActions =
      item.type === 'text' ||
      (bubblesToCreate.length === 1 && (isVideo || role === 'user'));

    const actions = doc.createElement('div');
    actions.className = 'message-actions';

    if (shouldAddStandardActions) {
      if (msg.queued) {
        const queuedBadge = doc.createElement('span');
        queuedBadge.className = 'queued-badge';
        queuedBadge.textContent = 'Queued';
        actions.appendChild(queuedBadge);
      }
      if (msg.timestamp) {
        const tsSpan = doc.createElement('span');
        tsSpan.className = 'message-timestamp';
        tsSpan.textContent = formatMessageTimestamp(msg.timestamp);
        actions.appendChild(tsSpan);
      }

      if (role === 'user') {
        if (!isMediaItem) {
          actions.appendChild(
            makeActionBtn('Reroll prompt', REROLL_USER_SVG, '', () => ctx.onReroll?.(msg, row, bubble))
          );
          actions.appendChild(
            makeActionBtn('Edit message', EDIT_SVG, '', () => ctx.onEdit?.(msg, row, bubble))
          );
        }
        actions.appendChild(
          makeActionBtn('Delete message', DELETE_SVG, '', () => ctx.onDelete?.(msg, row))
        );
        actions.appendChild(
          createFediverseShareButton({
            messageId: msgId,
            getRawText: () => (bubble.dataset.rawText ?? visibleText) || sharedPost?.url || '',
            getMedia: () => normalizedMedia,
            onOpenCompose: ctx.onOpenCompose,
          })
        );
      } else if (role === 'program') {
        if (isMsgTransient || isMediaItem) {
          actions.appendChild(
            makeActionBtn('Delete message', DELETE_SVG, '', () => ctx.onDelete?.(msg, row))
          );
        } else {
          actions.appendChild(
            makeActionBtn('Reroll response', REROLL_PROGRAM_SVG, '', () => ctx.onReroll?.(msg, row, bubble))
          );
          actions.appendChild(
            makeActionBtn('Edit response', EDIT_SVG, '', () => ctx.onEdit?.(msg, row, bubble))
          );
          actions.appendChild(
            makeActionBtn('Delete message', DELETE_SVG, '', () => ctx.onDelete?.(msg, row))
          );
          const speakBtn = makeActionBtn('Speak message', SPEAK_SVG, 'speak-btn', (btn) => ctx.onSpeak?.(msg, btn));
          speakBtn.dataset.msgId = msgId;
          actions.appendChild(speakBtn);
          syncSpeakButtonVisual(speakBtn, ctx.getSpeakState?.(msgId) || 'idle');
        }
      }
    }

    if (actions.children.length > 0) {
      bubble.appendChild(actions);
      const speakBtnInActions = actions.querySelector?.('.speak-btn');
      if (speakBtnInActions) {
        syncSpeakButtonVisual(speakBtnInActions, ctx.getSpeakState?.(msgId) || 'idle');
      }
    }

    if (item.type === 'text') {
      if (sharedPost) {
        bubble.appendChild(createSharedPostEmbedCard(sharedPost));
      }
      if (item.content && item.content.trim()) {
        const textDiv = doc.createElement('div');
        textDiv.className = 'message-text';
        renderMarkdownInto(textDiv, item.content, msg, ctx);
        bubble.appendChild(textDiv);
      }
      if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
        renderToolLogsAndMusic(bubble, msg.tool_calls, msg.duration);
      }
    } else if (item.type === 'media') {
      bubblesContainer.classList.add('has-portrait-grid');
      bubble.classList.add('has-portrait-grid');
      const grid = createPortraitGrid(
        mediaList,
        msgId,
        role,
        msg.sender_id || ctx.programId || '',
        sharedPrompt,
        ctx
      );
      bubble.appendChild(grid);
      updatePortraitGridToolbar(grid, ctx);
      if (isTextEmpty && idx === bubblesToCreate.length - 1 && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
        renderToolLogsAndMusic(bubble, msg.tool_calls, msg.duration);
      }
    }

    bubblesContainer.appendChild(bubble);
  });

  row.appendChild(bubblesContainer);
  return row;
}

export function findLiveRowById(chatContainer, msgId) {
  if (!chatContainer || !msgId) return null;
  for (const row of chatContainer.querySelectorAll(LIVE_ROW_SELECTOR)) {
    if (row.dataset.msgId === msgId) return row;
  }
  return null;
}

export function renderMessage(chatContainer, msg, ctx = {}) {
  const row = buildMessageRow(msg, ctx);
  if (!row || !chatContainer) return null;

  const existing = msg?.id ? findLiveRowById(chatContainer, msg.id) : null;
  if (existing) {
    if (existing.querySelector('.image-loading-overlay') || existing.querySelector('.message.editing')) {
      return existing;
    }
    chatContainer.replaceChild(row, existing);
    return row;
  }

  chatContainer.querySelector('#welcome-message')?.remove();
  const anchor = [...chatContainer.children].find((el) =>
    typeof el.matches === 'function' && el.matches('.typing-row, .thought-row, #active-thought-bubble, #bottom-sentinel')
  );
  chatContainer.insertBefore(row, anchor || null);
  chatContainer.scrollTop = chatContainer.scrollHeight;
  return row;
}

function nextLiveRow(el) {
  let n = el?.nextElementSibling || null;
  while (n && !n.matches?.(LIVE_ROW_SELECTOR)) {
    n = n.nextElementSibling;
  }
  return n;
}

/**
 * Idempotent DOM reconciliation preserving busy image/editing rows, collapsing duplicate IDs,
 * and keeping transient local notices intact until dismissed.
 */
export function reconcileChat(chatContainer, history, ctx = {}) {
  const rawMessages = Array.isArray(history) ? history : [];
  const lastIndexById = new Map();
  rawMessages.forEach((msg, idx) => {
    if (msg?.id) lastIndexById.set(msg.id, idx);
  });
  const messages = rawMessages.filter((msg, idx) => !msg || !msg.id || lastIndexById.get(msg.id) === idx);
  const wanted = new Set(messages.map((m) => m.id).filter(Boolean));
  let changed = false;

  const rowsById = new Map();
  for (const row of [...chatContainer.querySelectorAll(LIVE_ROW_SELECTOR)]) {
    const rowId = row.dataset.msgId;
    if (!rowId) continue;
    const isTransient = row.dataset.isTransient === 'true' || Boolean(row.querySelector('[data-is-transient="true"]'));
    if (!wanted.has(rowId) && !isTransient) {
      row.remove();
      changed = true;
    } else {
      const prevDup = rowsById.get(rowId);
      if (prevDup) {
        const prevBusy = Boolean(prevDup.querySelector('.image-loading-overlay') || prevDup.querySelector('.message.editing'));
        if (prevBusy) {
          row.remove();
          changed = true;
          continue;
        }
        prevDup.remove();
        changed = true;
      }
      rowsById.set(rowId, row);
    }
  }

  const sentinel = chatContainer.querySelector('#bottom-sentinel');
  const tailAnchor =
    chatContainer.querySelector('.typing-row')
    || chatContainer.querySelector('#active-thought-bubble')
    || sentinel
    || null;
  let cursor = chatContainer.querySelector(LIVE_ROW_SELECTOR);

  for (const msg of messages) {
    let row = msg.id ? rowsById.get(msg.id) : null;
    const isRowBusy = Boolean(row && (row.querySelector('.image-loading-overlay') || row.querySelector('.message.editing')));
    const hasStaleEditor = Boolean(row && !isRowBusy && row.querySelector('.edit-textarea, .edit-form'));

    if (row && !isRowBusy && (hasStaleEditor || row.dataset.contentHash !== computeContentHash(msg))) {
      const fresh = buildMessageRow(msg, ctx);
      if (fresh) {
        chatContainer.replaceChild(fresh, row);
        if (row === cursor) cursor = fresh;
        row = fresh;
        changed = true;
      }
    } else if (!row) {
      row = buildMessageRow(msg, ctx);
      if (row) changed = true;
    }
    if (!row) continue;

    if (row === cursor) {
      cursor = nextLiveRow(cursor);
    } else {
      chatContainer.insertBefore(row, cursor || tailAnchor);
      changed = true;
    }
  }

  if (messages.length > 0) {
    chatContainer.querySelector('#welcome-message')?.remove();
  }
  for (const avatarEl of [...chatContainer.querySelectorAll('.program-avatar')]) {
    const sid = avatarEl.getAttribute('data-sender-id')
      || avatarEl.closest?.('.message-row')?.dataset?.senderId
      || ctx.programId
      || '';
    if (!sid) continue;
    const expectedSrc = resolveRowAvatarSrc(sid, ctx);
    if (expectedSrc && avatarEl.src !== expectedSrc) {
      avatarEl.src = expectedSrc;
    }
  }
  for (const progBubble of [...chatContainer.querySelectorAll('.message.program')]) {
    const sid = progBubble.closest?.('.message-row')?.dataset?.senderId || ctx.programId || '';
    const resolvedTheme = (sid ? ctx.getThemeForProgram?.(sid) : null) || ctx.theme;
    if (resolvedTheme) {
      applyScopedProgramTheme(progBubble, resolvedTheme);
    } else {
      clearScopedProgramTheme(progBubble);
    }
  }
  return { changed, visibleCount: messages.length };
}

export function createTypingIndicatorRow(speakerId = '', ctx = {}) {
  const doc = globalThis.document;
  const row = doc.createElement('div');
  row.className = 'message-row program-row typing-row';
  if (speakerId) row.dataset.senderId = speakerId;

  const avatarContainer = doc.createElement('div');
  avatarContainer.className = 'avatar-container';
  const avatar = doc.createElement('img');
  avatar.className = 'avatar program-avatar';
  const targetId = speakerId || ctx.programId || 'sebile';
  avatar.setAttribute('data-sender-id', targetId);
  avatar.src = resolveRowAvatarSrc(targetId, ctx);
  avatar.alt = targetId || 'Program';
  avatar.title = 'View Recent Media';
  avatar.addEventListener('error', () => {
    if (avatar.src !== DEFAULT_AVATAR_DATA_URI) {
      avatar.src = DEFAULT_AVATAR_DATA_URI;
    }
  });
  avatar.addEventListener('click', () => {
    ctx.onOpenAvatarMedia?.(speakerId || ctx.programId || '', ctx.programName || speakerId || '');
  });
  avatarContainer.appendChild(avatar);
  row.appendChild(avatarContainer);

  const bubble = doc.createElement('div');
  bubble.className = 'message program';
  const theme = ctx.getThemeForProgram?.(speakerId) || ctx.theme;
  if (theme) applyScopedProgramTheme(bubble, theme);

  const indicator = doc.createElement('div');
  indicator.className = 'typing-indicator';
  for (let i = 0; i < 3; i += 1) {
    const dot = doc.createElement('div');
    dot.className = 'typing-dot';
    indicator.appendChild(dot);
  }
  bubble.appendChild(indicator);
  row.appendChild(bubble);
  return { row, bubble };
}

export function createIdleThoughtRow(text, speakerName = 'Program') {
  const doc = globalThis.document;
  const row = doc.createElement('div');
  row.id = 'active-thought-bubble';
  row.className = 'message-row program-row thought-row';

  const bubble = doc.createElement('div');
  bubble.className = 'message program thought-bubble';
  const label = doc.createElement('span');
  label.className = 'thought-label';
  label.textContent = `${speakerName} (idle thought): `;
  const body = doc.createElement('em');
  body.textContent = String(text || '');

  bubble.appendChild(label);
  bubble.appendChild(body);
  row.appendChild(bubble);
  return row;
}
