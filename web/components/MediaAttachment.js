/**
 * Fediverse post media carousel/single frame and composer attachment editor.
 */

const REMOVE_SVG = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>`;
const CAROUSEL_PREV_SVG = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="15 18 9 12 15 6"></polyline></svg>`;
const CAROUSEL_NEXT_SVG = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 18 15 12 9 6"></polyline></svg>`;

function buildMediaElement(doc, item, idx, total, onExpand, allItems) {
  const type = String(item.type || item.mimeType || item.mime_type || 'image').toLowerCase();
  const mime = String(item.mime_type || item.mimeType || '').toLowerCase();
  const url = item.url || item.previewUrl || item.hlsUrl || '';
  const altDesc = item.description || item.alt_text || '';
  const isVideo = type === 'video' || type === 'gifv' || mime.startsWith('video/') || mime === 'application/vnd.apple.mpegurl';
  const isAudio = type === 'audio' || mime.startsWith('audio/');

  if (isVideo) {
    const isGifv = type === 'gifv';
    const video = doc.createElement('video');
    video.className = 'post-media-item post-media-video';
    const w = Number.parseInt(item.width, 10) > 0 ? Number.parseInt(item.width, 10) : 640;
    const h = Number.parseInt(item.height, 10) > 0 ? Number.parseInt(item.height, 10) : 360;
    video.width = w;
    video.height = h;
    video.setAttribute('width', String(w));
    video.setAttribute('height', String(h));
    video.controls = true;
    video.setAttribute('controls', '');
    video.playsInline = true;
    video.setAttribute('playsinline', '');
    video.preload = 'metadata';
    video.setAttribute('preload', 'metadata');
    video.setAttribute('loading', 'lazy');
    if (item.previewUrl && item.previewUrl !== url) {
      video.poster = item.previewUrl;
      video.setAttribute('poster', item.previewUrl);
    }
    if (isGifv) {
      video.muted = true;
      video.loop = true;
      const reducedMotion = Boolean(globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches);
      if (!reducedMotion) {
        video.autoplay = true;
      }
    }
    if (altDesc) {
      video.setAttribute('aria-label', altDesc);
    }

    const canPlayHls = Boolean(item.hlsUrl && video.canPlayType?.('application/vnd.apple.mpegurl'));
    if (canPlayHls) {
      const hlsSource = doc.createElement('source');
      hlsSource.setAttribute('src', item.hlsUrl);
      hlsSource.setAttribute('type', 'application/vnd.apple.mpegurl');
      video.appendChild(hlsSource);
      if (url && url !== item.hlsUrl) {
        const mp4Source = doc.createElement('source');
        mp4Source.setAttribute('src', url);
        mp4Source.setAttribute('type', mime.startsWith('video/') ? mime : 'video/mp4');
        video.appendChild(mp4Source);
      }
    } else if (url) {
      video.src = url;
      video.setAttribute('src', url);
    }

    if (item.did && item.cid) {
      video.addEventListener('error', () => {
        void (async () => {
          try {
            const plcRes = await fetch(`https://plc.directory/${encodeURIComponent(item.did)}`);
            if (!plcRes.ok) return;
            const plcDoc = await plcRes.json();
            const services = Array.isArray(plcDoc?.service) ? plcDoc.service : [];
            const pds = services.find((s) => s?.id === '#atproto_pds')?.serviceEndpoint || '';
            if (typeof pds === 'string' && pds.startsWith('https://')) {
              const directUrl = `${pds.replace(/\/+$/, '')}/xrpc/com.atproto.sync.getBlob?did=${encodeURIComponent(item.did)}&cid=${encodeURIComponent(item.cid)}`;
              if (directUrl !== video.src) {
                video.src = directUrl;
                video.setAttribute('src', directUrl);
              }
            }
          } catch {
            // Ignore PDS lookup failure
          }
        })();
      }, { once: true });
    }

    video.addEventListener('click', (e) => e.stopPropagation());
    return video;
  }

  if (isAudio) {
    const audio = doc.createElement('audio');
    audio.className = 'post-media-audio';
    audio.controls = true;
    audio.setAttribute('controls', '');
    audio.preload = 'metadata';
    audio.setAttribute('preload', 'metadata');
    audio.setAttribute('loading', 'lazy');
    if (url) {
      audio.src = url;
      audio.setAttribute('src', url);
    }
    if (altDesc) {
      audio.setAttribute('aria-label', altDesc);
    }
    audio.addEventListener('click', (e) => e.stopPropagation());
    return audio;
  }

  const btn = doc.createElement('button');
  btn.type = 'button';
  btn.className = 'post-media-thumb-btn';
  const posLabel = total > 1 ? `image ${idx + 1} of ${total}` : 'attached image';
  btn.setAttribute('aria-label', altDesc ? `View ${posLabel}: ${altDesc}` : `View ${posLabel}`);

  const img = doc.createElement('img');
  img.className = 'post-media-item';
  img.src = mime === 'image/gif' ? (url || item.previewUrl || '') : (item.previewUrl || url);
  img.alt = altDesc || 'Post attachment';
  img.loading = 'lazy';
  img.decoding = 'async';
  btn.appendChild(img);

  if (typeof onExpand === 'function') {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      onExpand(item, idx, allItems);
    });
  }
  return btn;
}

export function createPostMediaGrid(media = [], { onExpand } = {}) {
  const doc = globalThis.document;
  const validItems = (Array.isArray(media) ? media : []).filter((item) => item && (item.url || item.previewUrl || item.hlsUrl));

  if (validItems.length <= 1) {
    const single = doc.createElement('div');
    let extraClass = '';
    if (validItems.length === 1) {
      const sType = String(validItems[0].type || '').toLowerCase();
      const sMime = String(validItems[0].mime_type || validItems[0].mimeType || '').toLowerCase();
      if (sType === 'video' || sType === 'gifv' || sMime.startsWith('video/') || sMime === 'application/vnd.apple.mpegurl') {
        extraClass = ' has-video';
      } else if (sType === 'audio' || sMime.startsWith('audio/')) {
        extraClass = ' has-audio';
      }
    }
    single.className = `post-media-grid post-media-single post-media-count-${validItems.length}${extraClass}`;
    if (validItems.length === 1) {
      single.appendChild(buildMediaElement(doc, validItems[0], 0, 1, onExpand, validItems));
    }
    return single;
  }

  const total = validItems.length;
  const carousel = doc.createElement('div');
  carousel.className = 'post-media-carousel';
  carousel.setAttribute('role', 'group');
  carousel.setAttribute('aria-roledescription', 'carousel');
  carousel.setAttribute('aria-label', 'Post media');

  const viewport = doc.createElement('div');
  viewport.className = 'post-carousel-viewport';

  const controls = doc.createElement('div');
  controls.className = 'post-carousel-controls';

  const prevBtn = doc.createElement('button');
  prevBtn.type = 'button';
  prevBtn.className = 'post-carousel-btn post-carousel-prev';
  prevBtn.dataset.direction = 'previous';
  prevBtn.setAttribute('aria-label', 'Previous image');
  prevBtn.disabled = true;
  prevBtn.innerHTML = CAROUSEL_PREV_SVG;

  const nextBtn = doc.createElement('button');
  nextBtn.type = 'button';
  nextBtn.className = 'post-carousel-btn post-carousel-next';
  nextBtn.dataset.direction = 'next';
  nextBtn.setAttribute('aria-label', 'Next image');
  nextBtn.innerHTML = CAROUSEL_NEXT_SVG;

  controls.append(prevBtn, nextBtn);

  const counterEl = doc.createElement('span');
  counterEl.className = 'post-carousel-counter';
  counterEl.setAttribute('aria-hidden', 'true');
  counterEl.textContent = `1 / ${total}`;

  const track = doc.createElement('div');
  track.className = 'post-carousel-track';
  track.tabIndex = 0;
  track.setAttribute('tabindex', '0');
  track.setAttribute('role', 'group');
  track.setAttribute('aria-label', 'Post attachments');

  const slides = [];
  validItems.forEach((item, idx) => {
    const slide = doc.createElement('div');
    slide.className = 'post-carousel-slide';
    slide.setAttribute('role', 'group');
    slide.setAttribute('aria-roledescription', 'slide');
    slide.setAttribute('aria-label', `${idx + 1} of ${total}`);
    slide.dataset.markerName = `Go to image ${idx + 1}`;
    slide.appendChild(buildMediaElement(doc, item, idx, total, onExpand, validItems));
    slides.push(slide);
    track.appendChild(slide);
  });

  viewport.append(controls, counterEl, track);

  const statusEl = doc.createElement('p');
  statusEl.className = 'sr-only post-carousel-status';
  statusEl.setAttribute('role', 'status');
  statusEl.setAttribute('aria-live', 'polite');

  const markersEl = doc.createElement('div');
  markersEl.className = 'post-carousel-markers';
  markersEl.setAttribute('role', 'group');
  markersEl.setAttribute('aria-label', 'Choose an image');

  const dots = validItems.map((_, idx) => {
    const dot = doc.createElement('button');
    dot.type = 'button';
    dot.className = 'post-carousel-dot';
    dot.setAttribute('aria-label', `Go to image ${idx + 1}`);
    if (idx === 0) {
      dot.setAttribute('aria-current', 'true');
    }
    markersEl.appendChild(dot);
    return dot;
  });

  carousel.append(viewport, statusEl, markersEl);

  let settledIndex = 0;
  let pendingIndex = null;
  let userInitiated = false;
  let rafId = null;
  let fallbackTimer = null;

  const readTrackIndex = () => {
    const firstLeft = typeof slides[0]?.offsetLeft === 'number' ? slides[0].offsetLeft : 0;
    const stride =
      slides.length > 1 && typeof slides[1]?.offsetLeft === 'number' && slides[1].offsetLeft > firstLeft
        ? slides[1].offsetLeft - firstLeft
        : (track.clientWidth || 0);
    if (!stride) return settledIndex;
    const raw = Math.round((track.scrollLeft || 0) / stride);
    return Math.max(0, Math.min(total - 1, raw));
  };

  const syncControls = (activeIdx) => {
    counterEl.textContent = `${activeIdx + 1} / ${total}`;
    dots.forEach((dot, i) => {
      if (i === activeIdx) {
        dot.setAttribute('aria-current', 'true');
      } else {
        dot.removeAttribute('aria-current');
      }
    });
    const wasPrevFocused = doc.activeElement === prevBtn;
    const wasNextFocused = doc.activeElement === nextBtn;
    prevBtn.disabled = activeIdx <= 0;
    nextBtn.disabled = activeIdx >= total - 1;
    if (wasPrevFocused && prevBtn.disabled && !nextBtn.disabled) {
      nextBtn.focus?.();
    } else if (wasNextFocused && nextBtn.disabled && !prevBtn.disabled) {
      prevBtn.focus?.();
    }
  };

  const commitSettled = (nextIdx) => {
    const clamped = Math.max(0, Math.min(total - 1, nextIdx));
    const changed = clamped !== settledIndex;
    settledIndex = clamped;
    pendingIndex = null;
    syncControls(settledIndex);
    const label = `Image ${settledIndex + 1} of ${total}`;
    if (userInitiated && (changed || statusEl.textContent !== label)) {
      statusEl.textContent = label;
    }
  };

  const goToSlide = (targetIdx) => {
    const clamped = Math.max(0, Math.min(total - 1, targetIdx));
    userInitiated = true;
    pendingIndex = clamped;
    syncControls(clamped);

    const firstLeft = typeof slides[0]?.offsetLeft === 'number' ? slides[0].offsetLeft : 0;
    const targetLeft =
      typeof slides[clamped]?.offsetLeft === 'number'
        ? Math.max(0, slides[clamped].offsetLeft - firstLeft)
        : clamped * (track.clientWidth || 0);
    const prevScrollLeft = Number(track.scrollLeft || 0);
    const prefersReduced = Boolean(globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches);
    const noScrollNeeded = !track.clientWidth || Math.abs(prevScrollLeft - targetLeft) < 1;

    if (typeof track.scrollTo === 'function') {
      track.scrollTo({ left: targetLeft, behavior: prefersReduced ? 'auto' : 'smooth' });
    } else {
      track.scrollLeft = targetLeft;
    }

    if (noScrollNeeded || prefersReduced || typeof track.scrollTo !== 'function') {
      commitSettled(clamped);
    }
  };

  prevBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!prevBtn.disabled) {
      goToSlide((pendingIndex ?? settledIndex) - 1);
    }
  });

  nextBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!nextBtn.disabled) {
      goToSlide((pendingIndex ?? settledIndex) + 1);
    }
  });

  dots.forEach((dot, idx) => {
    dot.addEventListener('click', (e) => {
      e.stopPropagation();
      goToSlide(idx);
    });
  });

  const hasScrollEnd = 'onscrollend' in track || 'onscrollend' in globalThis;
  if (hasScrollEnd) {
    track.addEventListener('scrollend', () => {
      commitSettled(pendingIndex ?? readTrackIndex());
    });
  }

  track.addEventListener(
    'scroll',
    () => {
      userInitiated = true;
      if (pendingIndex === null) {
        if (typeof globalThis.requestAnimationFrame === 'function') {
          if (rafId === null) {
            rafId = globalThis.requestAnimationFrame(() => {
              rafId = null;
              syncControls(readTrackIndex());
            });
          }
        } else {
          syncControls(readTrackIndex());
        }
      }
      if (!hasScrollEnd) {
        clearTimeout(fallbackTimer);
        fallbackTimer = setTimeout(() => {
          commitSettled(pendingIndex ?? readTrackIndex());
        }, 120);
      }
    },
    { passive: true }
  );

  return carousel;
}

export function createComposerMediaEditor(attachments = [], { onRemove } = {}) {
  const doc = globalThis.document;
  const strip = doc.createElement('div');
  strip.className = 'composer-media-strip';

  for (const att of attachments) {
    const card = doc.createElement('div');
    card.className = `composer-media-card${attachments.length === 1 ? ' is-single' : ''}`;

    const previewUrl = att.previewUrl || att.url || '';
    const mime = String(att.mimeType || '');
    const isVideo = mime.startsWith('video/');
    const isAudio = mime.startsWith('audio/');

    if (isAudio) {
      const tile = doc.createElement('div');
      tile.className = 'composer-media-audio-tile';
      tile.textContent = att.file?.name || 'Audio';
      card.appendChild(tile);
    } else if (previewUrl) {
      if (isVideo) {
        const v = doc.createElement('video');
        v.className = 'composer-media-thumb';
        v.src = previewUrl;
        v.muted = true;
        v.playsInline = true;
        card.appendChild(v);
      } else {
        const img = doc.createElement('img');
        img.className = 'composer-media-thumb';
        img.src = previewUrl;
        img.alt = 'Attached media';
        card.appendChild(img);
      }
    }

    const removeBtn = doc.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'composer-media-remove';
    removeBtn.setAttribute('aria-label', 'Remove attachment');
    removeBtn.title = 'Remove attachment';
    removeBtn.innerHTML = REMOVE_SVG;
    removeBtn.addEventListener('click', () => onRemove?.(att.id));

    card.appendChild(removeBtn);
    strip.appendChild(card);
  }

  return strip;
}
