import { DEFAULT_AVATAR_DATA_URI } from '../../constants/avatars.js';
import { applyScopedProgramTheme } from '../../constants/theme.js';
import {
  resolveProgramAvatarUrl,
  resolveSanctuaryMediaUrl,
} from '../../queries/sanctuary.js';
import { createFediverseShareButton } from '../FediverseShareButton.js';
import { createPortraitGrid, openMediaLightbox, updatePortraitGridToolbar } from './PortraitGrid.js';

export const LIVE_ROW_SELECTOR = '.message-row:not(#welcome-message):not(.typing-row):not(.thought-row)';

const REROLL_USER_SVG = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 17 4 12 9 7"></polyline><path d="M20 18v-2a4 4 0 0 0-4-4H4"></path></svg>`;
const REROLL_PROGRAM_SVG = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"></path></svg>`;
const EDIT_SVG = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 1 1 3 3L12 15l-4 1 1-4z"></path></svg>`;
const DELETE_SVG = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg>`;
const SPEAK_SVG = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"></path></svg>`;
const PHONE_SVG = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"></path></svg>`;

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
  const byline = `[Shared post by ${sp.authorName}${sp.authorHandle ? ` (${sp.authorHandle})` : ''}]`;
  const parts = [byline];
  if (sp.text) parts.push(sp.text);
  if (sp.mediaUrl) {
    parts.push(`[Image${sp.mediaAlt ? `: ${sp.mediaAlt}` : ' attached'}]`);
  }
  const block = parts.join('\n');
  return cleanNote ? `${block}\n\n${cleanNote}` : block;
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

/**
 * Parse search_music tool output into structured discovery cards.
 */
export function parseMusicDiscoveryItems(toolCalls = []) {
  const cards = [];
  for (const tc of toolCalls) {
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
      if (tag === 'pre' || tag === 'code' || tag === 'a' || tag === 'button' || tag === 'textarea') {
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

function renderMarkdownInto(element, rawText) {
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

function renderToolLogsAndMusic(bubble, toolCalls = [], duration = null) {
  const doc = globalThis.document;
  const paired = [];
  const resById = new Map();
  for (const tc of toolCalls) {
    if (tc?.type === 'result') {
      resById.set(tc.id || tc.name, tc.content || tc.response || '');
    }
  }
  for (const tc of toolCalls) {
    if (tc?.type === 'result') continue;
    paired.push({
      id: tc.id || '',
      name: tc.name || 'tool',
      args: tc.args || {},
      response: tc.response ?? resById.get(tc.id || tc.name) ?? '',
    });
  }

  if (paired.length > 0) {
    const container = doc.createElement('div');
    container.className = 'tool-logs-container';

    const summaryBtn = doc.createElement('button');
    summaryBtn.type = 'button';
    summaryBtn.className = 'tool-logs-summary-btn';
    summaryBtn.setAttribute('aria-expanded', 'false');
    summaryBtn.textContent = duration
      ? `Worked for ${duration}s (${paired.length} tool call${paired.length > 1 ? 's' : ''})`
      : `Activity (${paired.length} tool call${paired.length > 1 ? 's' : ''})`;

    const listEl = doc.createElement('div');
    listEl.className = 'tool-logs-body';
    listEl.hidden = true;

    for (const tc of paired) {
      const item = doc.createElement('div');
      item.className = 'tool-log-entry';
      const head = doc.createElement('div');
      head.className = 'tool-log-head';
      head.textContent = `${tc.name}(${Object.keys(tc.args).length ? JSON.stringify(tc.args).slice(0, 80) : ''})`;
      const detail = doc.createElement('pre');
      detail.className = 'tool-log-detail';
      detail.textContent = String(tc.response || '').slice(0, 600);
      item.appendChild(head);
      item.appendChild(detail);
      listEl.appendChild(item);
    }

    summaryBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const expanded = !listEl.hidden;
      listEl.hidden = expanded;
      summaryBtn.setAttribute('aria-expanded', expanded ? 'false' : 'true');
    });

    container.appendChild(summaryBtn);
    container.appendChild(listEl);
    bubble.appendChild(container);
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
  const sharedPost = msg.shared_post ? normalizeSharedPostCard(msg.shared_post) : null;
  const visibleText = sharedPost ? String(msg.user_note ?? '') : text;
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
    avatar.src = resolveProgramAvatarUrl(speakerId, {
      cacheBuster: ctx.getAvatarVersion?.(speakerId) ?? ctx.cacheBuster,
    });
    avatar.alt = msg.sender_name || 'Program';
    avatar.title = 'View Recent Media';
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
    const mediaList = isMediaItem ? item.content.slice(0, 3) : [];
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
          actions.appendChild(
            makeActionBtn('Speak message', SPEAK_SVG, 'speak-btn', (btn) => ctx.onSpeak?.(msg, btn))
          );
        }
      }
    }

    if (actions.children.length > 0) {
      bubble.appendChild(actions);
    }

    if (item.type === 'text') {
      if (sharedPost) {
        bubble.appendChild(createSharedPostEmbedCard(sharedPost));
      }
      if (item.content && item.content.trim()) {
        const textDiv = doc.createElement('div');
        textDiv.className = 'message-text';
        renderMarkdownInto(textDiv, item.content);
        bubble.appendChild(textDiv);
      }
      if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
        renderToolLogsAndMusic(bubble, msg.tool_calls, msg.duration);
      }
    } else if (item.type === 'media') {
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

    if (row && !isRowBusy && row.dataset.contentHash !== computeContentHash(msg)) {
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
    const expectedSrc = resolveProgramAvatarUrl(sid, {
      cacheBuster: ctx.getAvatarVersion?.(sid) ?? ctx.cacheBuster,
    });
    if (expectedSrc && avatarEl.src !== expectedSrc) {
      avatarEl.src = expectedSrc;
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
  avatar.src = resolveProgramAvatarUrl(targetId, {
    cacheBuster: ctx.getAvatarVersion?.(targetId) ?? ctx.cacheBuster,
  });
  avatar.alt = targetId || 'Program';
  avatar.title = 'View Recent Media';
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
