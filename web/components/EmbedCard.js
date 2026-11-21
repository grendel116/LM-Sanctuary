import { extractFirstHttpsUrl, parseVideoEmbedInfo } from '../queries/linkPreview.js';

const PLAY_ICON_SVG = `<svg width="26" height="26" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><polygon points="6 4 20 12 6 20 6 4"></polygon></svg>`;

function normalizeSafeHttpUrl(raw) {
  try {
    const parsed = new URL(String(raw || '').trim());
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return { href: parsed.href, host: parsed.hostname.replace(/^www\./i, '') };
    }
  } catch {
    // Ignore invalid URL
  }
  return null;
}

function isAllowedIframeEmbedUrl(raw) {
  try {
    const parsed = new URL(String(raw || '').trim());
    if (parsed.protocol !== 'https:') return '';
    const host = parsed.hostname.toLowerCase();
    if (host === 'www.youtube-nocookie.com' && parsed.pathname.startsWith('/embed/')) return parsed.href;
    if (host === 'player.vimeo.com' && parsed.pathname.startsWith('/video/')) return parsed.href;
  } catch {
    // Ignore invalid embed URL
  }
  return '';
}

/**
 * Resolve rich embed / link card metadata for a UnifiedItem, enriching bare YouTube/Vimeo links
 * with a privacy-friendly click-to-play video facade when no media grid is attached.
 */
export function resolvePostEmbedCard(unifiedItem) {
  const rawCard = unifiedItem?._meta?.linkCard || unifiedItem?.linkCard || null;
  if (rawCard?.url) {
    const safe = normalizeSafeHttpUrl(rawCard.url);
    if (safe) {
      const video = parseVideoEmbedInfo(safe.href);
      const image = rawCard.image || video?.thumbnailUrl || '';
      const embedUrl = isAllowedIframeEmbedUrl(rawCard.embedUrl) || video?.embedUrl || '';
      const provider = rawCard.provider || video?.provider || '';
      if (embedUrl || rawCard.title || rawCard.description) {
        return {
          url: safe.href,
          title: String(rawCard.title || (video ? `${video.provider === 'youtube' ? 'YouTube' : 'Vimeo'} Video` : safe.host)),
          description: String(rawCard.description || ''),
          image: /^https:\/\//i.test(String(image)) ? String(image) : '',
          siteName: String(rawCard.siteName || safe.host),
          provider,
          embedUrl,
          ...(video?.isPortrait ? { isPortrait: true } : {}),
        };
      }
    }
  }

  const attachments = Array.isArray(unifiedItem?.attachments) ? unifiedItem.attachments : [];
  if (attachments.length > 0) return null;

  const firstUrl = extractFirstHttpsUrl(unifiedItem?.content_text || '');
  if (!firstUrl) return null;
  const video = parseVideoEmbedInfo(firstUrl);
  if (!video) return null;

  return {
    url: firstUrl,
    title: video.provider === 'youtube' ? 'YouTube Video' : 'Vimeo Video',
    description: '',
    image: video.thumbnailUrl || '',
    siteName: video.provider === 'youtube' ? 'youtube.com' : 'vimeo.com',
    provider: video.provider,
    embedUrl: video.embedUrl,
    ...(video.isPortrait ? { isPortrait: true } : {}),
  };
}

/**
 * Build either a privacy-preserving click-to-play video facade or a standard external link card.
 * @param {object} card
 * @param {{ compact?: boolean, onDismiss?: () => void }} [opts]
 */
export function createEmbedCard(card, { compact = false, onDismiss = null } = {}) {
  const doc = globalThis.document;
  const safe = normalizeSafeHttpUrl(card?.url);
  if (!safe) return null;

  const video = parseVideoEmbedInfo(safe.href);
  const embedSrc = isAllowedIframeEmbedUrl(card?.embedUrl) || video?.embedUrl || '';
  const provider = String(card?.provider || video?.provider || '').toLowerCase();
  const thumbSrc = String(card?.image || video?.thumbnailUrl || '').trim();
  const titleText = String(card?.title || safe.host || '');
  const descText = String(card?.description || '');
  const siteLabel = String(card?.siteName || safe.host || '');

  if (embedSrc) {
    const container = doc.createElement('div');
    container.className = `post-link-card post-embed-card${compact ? ' is-compact' : ''}`;
    if ((card?.isPortrait || video?.isPortrait) && !compact) {
      container.dataset.portrait = 'true';
    }

    const stage = doc.createElement('div');
    stage.className = 'post-embed-stage';

    if (/^https:\/\//i.test(thumbSrc)) {
      const thumb = doc.createElement('img');
      thumb.className = 'post-embed-thumb';
      thumb.src = thumbSrc;
      thumb.alt = '';
      thumb.loading = 'lazy';
      thumb.decoding = 'async';
      thumb.addEventListener('error', () => thumb.remove(), { once: true });
      stage.appendChild(thumb);
    }

    const playBtn = doc.createElement('button');
    playBtn.type = 'button';
    playBtn.className = 'post-embed-play-btn';
    playBtn.setAttribute('aria-label', `Play embedded video: ${titleText}`);
    playBtn.innerHTML = `${PLAY_ICON_SVG}<span class="post-embed-provider-pill">${provider === 'vimeo' ? 'Vimeo' : 'YouTube'}</span>`;
    const activateEmbed = (e) => {
      if (e.target?.closest?.('.compose-embed-dismiss-btn') || stage.querySelector('iframe.post-embed-iframe')) return;
      e.preventDefault();
      e.stopPropagation();
      const iframe = doc.createElement('iframe');
      iframe.className = 'post-embed-iframe';
      iframe.src = embedSrc;
      iframe.title = titleText || 'Embedded video';
      iframe.setAttribute('loading', 'lazy');
      iframe.setAttribute('allow', 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture');
      iframe.setAttribute('allowfullscreen', '');
      iframe.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
      iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-presentation allow-popups');
      stage.replaceChildren(iframe);
    };
    playBtn.addEventListener('click', activateEmbed);
    stage.addEventListener('click', activateEmbed);
    stage.appendChild(playBtn);

    if (typeof onDismiss === 'function') {
      const dismissBtn = doc.createElement('button');
      dismissBtn.type = 'button';
      dismissBtn.className = 'compose-embed-dismiss-btn';
      dismissBtn.setAttribute('aria-label', 'Remove link preview');
      dismissBtn.title = 'Remove link preview';
      dismissBtn.textContent = '×';
      dismissBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        onDismiss();
      });
      stage.appendChild(dismissBtn);
    }

    const metaLink = doc.createElement('a');
    metaLink.className = 'post-link-card-meta post-embed-meta-link';
    metaLink.href = safe.href;
    metaLink.setAttribute('target', '_blank');
    metaLink.setAttribute('rel', 'noopener noreferrer');
    metaLink.addEventListener('click', (e) => e.stopPropagation());

    const domainEl = doc.createElement('span');
    domainEl.className = 'post-link-card-domain';
    domainEl.textContent = siteLabel;
    const titleEl = doc.createElement('strong');
    titleEl.className = 'post-link-card-title';
    titleEl.textContent = titleText;
    metaLink.append(domainEl, titleEl);

    if (descText && !compact) {
      const descEl = doc.createElement('p');
      descEl.className = 'post-link-card-desc';
      descEl.textContent = descText;
      metaLink.appendChild(descEl);
    }

    container.append(stage, metaLink);
    return container;
  }

  const cardAnchor = doc.createElement('a');
  cardAnchor.className = `post-link-card${compact ? ' is-compact' : ''}`;
  cardAnchor.href = safe.href;
  cardAnchor.setAttribute('target', '_blank');
  cardAnchor.setAttribute('rel', 'noopener noreferrer');

  if (/^https:\/\//i.test(thumbSrc)) {
    const thumb = doc.createElement('img');
    thumb.className = 'post-link-card-thumb';
    thumb.src = thumbSrc;
    thumb.alt = '';
    thumb.loading = 'lazy';
    thumb.decoding = 'async';
    thumb.addEventListener('error', () => thumb.remove(), { once: true });
    cardAnchor.appendChild(thumb);
  }

  const metaBox = doc.createElement('div');
  metaBox.className = 'post-link-card-meta';

  const domainEl = doc.createElement('span');
  domainEl.className = 'post-link-card-domain';
  domainEl.textContent = siteLabel;

  const titleEl = doc.createElement('strong');
  titleEl.className = 'post-link-card-title';
  titleEl.textContent = titleText;
  metaBox.append(domainEl, titleEl);

  if (descText && !compact) {
    const descEl = doc.createElement('p');
    descEl.className = 'post-link-card-desc';
    descEl.textContent = descText;
    metaBox.appendChild(descEl);
  }

  cardAnchor.appendChild(metaBox);

  if (typeof onDismiss === 'function') {
    const wrap = doc.createElement('div');
    wrap.className = 'compose-link-preview-wrap';
    const dismissBtn = doc.createElement('button');
    dismissBtn.type = 'button';
    dismissBtn.className = 'compose-embed-dismiss-btn';
    dismissBtn.setAttribute('aria-label', 'Remove link preview');
    dismissBtn.title = 'Remove link preview';
    dismissBtn.textContent = '×';
    dismissBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      onDismiss();
    });
    wrap.append(cardAnchor, dismissBtn);
    return wrap;
  }

  return cardAnchor;
}
