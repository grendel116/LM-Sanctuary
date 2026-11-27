/**
 * Fediverse post media carousel/single frame and composer attachment editor.
 */

const REMOVE_SVG = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>`;
const CAROUSEL_PREV_SVG = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="15 18 9 12 15 6"></polyline></svg>`;
const CAROUSEL_NEXT_SVG = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 18 15 12 9 6"></polyline></svg>`;
const EYE_OPEN_SVG = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>`;
const EYE_OFF_SVG = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path><line x1="1" y1="1" x2="23" y2="23"></line></svg>`;

let sensitiveGateSeq = 0;

const MIN_MEDIA_RATIO = 0.35;
const MAX_MEDIA_RATIO = 2.6;

function clampAspectRatio(rawRatio) {
  return Math.max(MIN_MEDIA_RATIO, Math.min(MAX_MEDIA_RATIO, rawRatio));
}

function getItemAspectRatio(item) {
  const w = Number.parseInt(item?.width, 10);
  const h = Number.parseInt(item?.height, 10);
  if (Number.isFinite(w) && w > 0 && Number.isFinite(h) && h > 0) {
    return clampAspectRatio(w / h);
  }
  return null;
}

function buildMediaElement(doc, item, idx, total, onExpand, allItems, { onRatioResolved, mediaPriority = 'lazy' } = {}) {
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
    const w = Number.parseInt(item.width, 10);
    const h = Number.parseInt(item.height, 10);
    if (Number.isFinite(w) && w > 0 && Number.isFinite(h) && h > 0) {
      video.width = w;
      video.height = h;
      video.setAttribute('width', String(w));
      video.setAttribute('height', String(h));
    }
    video.disablePictureInPicture = true;
    video.setAttribute('disablepictureinpicture', '');
    video.controls = true;
    video.setAttribute('controls', '');
    video.playsInline = true;
    video.setAttribute('playsinline', '');
    video.preload = 'metadata';
    video.setAttribute('preload', 'metadata');
    if (mediaPriority === 'lazy' || idx > 0) {
      video.setAttribute('loading', 'lazy');
    }
    if (item.previewUrl && item.previewUrl !== url) {
      video.poster = item.previewUrl;
      video.setAttribute('poster', item.previewUrl);
    }
    if (isGifv) {
      video.dataset.isGifv = 'true';
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

    video.addEventListener('loadedmetadata', () => {
      if (video.videoWidth > 0 && video.videoHeight > 0) {
        video.width = video.videoWidth;
        video.height = video.videoHeight;
        video.setAttribute('width', String(video.videoWidth));
        video.setAttribute('height', String(video.videoHeight));
        onRatioResolved?.(clampAspectRatio(video.videoWidth / video.videoHeight), video.videoWidth, video.videoHeight);
      }
    }, { once: true });

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
  img.alt = altDesc || 'Post attachment';
  if (mediaPriority === 'high' && idx === 0) {
    img.fetchPriority = 'high';
    img.setAttribute('fetchpriority', 'high');
  } else if (mediaPriority === 'eager' && (idx === 0 || total === 2)) {
    // Eager above-the-fold fetch without overriding default fetchpriority.
  } else if (mediaPriority !== 'lazy' && idx > 0) {
    img.loading = 'lazy';
    img.fetchPriority = 'low';
    img.setAttribute('fetchpriority', 'low');
  } else {
    img.loading = 'lazy';
  }
  img.decoding = 'async';
  img.referrerPolicy = 'no-referrer';
  img.setAttribute('referrerpolicy', 'no-referrer');
  const w = Number.parseInt(item.width, 10);
  const h = Number.parseInt(item.height, 10);
  if (Number.isFinite(w) && w > 0 && Number.isFinite(h) && h > 0) {
    img.width = w;
    img.height = h;
    img.setAttribute('width', String(w));
    img.setAttribute('height', String(h));
  }
  let handledReady = false;
  const handleImgReady = () => {
    if (handledReady) return;
    handledReady = true;
    img.dataset.loaded = 'true';
    if (typeof onRatioResolved === 'function' && img.naturalWidth > 0 && img.naturalHeight > 0) {
      onRatioResolved(clampAspectRatio(img.naturalWidth / img.naturalHeight), img.naturalWidth, img.naturalHeight);
    }
  };
  img.addEventListener('load', handleImgReady, { once: true });
  const fallbackPreview = String(item.previewUrl || '').trim();
  if (fallbackPreview && fallbackPreview !== (url || '')) {
    img.addEventListener('error', () => {
      if (img.src !== fallbackPreview) {
        img.src = fallbackPreview;
      }
    }, { once: true });
  }
  img.src = url || item.previewUrl || '';
  if (img.complete && img.naturalWidth > 0) {
    queueMicrotask(handleImgReady);
  }
  btn.appendChild(img);

  if (typeof onExpand === 'function') {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      onExpand(item, idx, allItems);
    });
  }
  return btn;
}

function setGridInertState(gridEl, isInert) {
  gridEl.inert = Boolean(isInert);
  if (isInert) {
    gridEl.setAttribute?.('inert', '');
  } else {
    gridEl.removeAttribute?.('inert');
  }
}

function wrapSensitiveMediaGrid(doc, gridEl, sensitiveWarning) {
  sensitiveGateSeq += 1;
  const gridId = `post-sensitive-media-${sensitiveGateSeq}`;
  gridEl.id = gridId;

  const wrap = doc.createElement('div');
  wrap.className = 'post-media-sensitive-wrap is-blurred';

  const stage = doc.createElement('div');
  stage.className = 'post-media-sensitive-stage';

  const toggleBtn = doc.createElement('button');
  toggleBtn.type = 'button';
  toggleBtn.className = 'post-media-sensitive-btn';
  toggleBtn.setAttribute('aria-controls', gridId);

  const iconEl = doc.createElement('span');
  iconEl.className = 'post-media-sensitive-icon';
  iconEl.setAttribute('aria-hidden', 'true');
  iconEl.style.display = 'contents';

  const labelEl = doc.createElement('span');
  labelEl.className = 'post-media-sensitive-label';

  toggleBtn.append(iconEl, labelEl);

  const videos = [...gridEl.querySelectorAll('video')];
  let revealed = false;

  const syncGateState = () => {
    wrap.classList.toggle('is-blurred', !revealed);
    wrap.classList.toggle('is-revealed', revealed);
    setGridInertState(gridEl, !revealed);
    toggleBtn.setAttribute('aria-expanded', revealed ? 'true' : 'false');
    iconEl.innerHTML = revealed ? EYE_OFF_SVG : EYE_OPEN_SVG;
    labelEl.textContent = revealed ? 'Hide media' : `Show · ${sensitiveWarning}`;
    const reducedMotion = Boolean(globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches);
    for (const v of videos) {
      if (!revealed) {
        v.autoplay = false;
        try {
          v.pause?.();
        } catch {
          // Ignore pause errors in synthetic DOM
        }
      } else if (v.dataset?.isGifv === 'true' && !reducedMotion) {
        v.autoplay = true;
        try {
          v.play?.()?.catch?.(() => {});
        } catch {
          // Ignore play errors in synthetic DOM
        }
      }
    }
  };

  toggleBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    revealed = !revealed;
    syncGateState();
  });

  syncGateState();
  stage.append(gridEl, toggleBtn);
  wrap.appendChild(stage);
  return wrap;
}

function buildRawMediaGrid(doc, validItems, onExpand, { forceCarousel = false, mediaPriority = 'lazy' } = {}) {
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
      const only = validItems[0];
      const applySingleRatio = extraClass !== ' has-audio'
        ? (ratio, w, h) => {
            if (!Number.isFinite(ratio) || ratio <= 0) return;
            single.dataset.hasRatio = 'true';
            const isPortrait = w > 0 && h > 0 ? h > w : ratio < 1;
            if (isPortrait) {
              single.dataset.portrait = 'true';
            } else {
              delete single.dataset.portrait;
            }
            single.style.setProperty('--media-ratio', ratio.toFixed(4));
            single.style.setProperty('--media-aspect', w > 0 && h > 0 ? `${w} / ${h}` : `${ratio.toFixed(4)} / 1`);
          }
        : null;
      if (applySingleRatio) {
        const initRatio = getItemAspectRatio(only);
        if (initRatio) {
          applySingleRatio(initRatio, Number.parseInt(only.width, 10) || 0, Number.parseInt(only.height, 10) || 0);
        }
      }
      single.appendChild(buildMediaElement(doc, only, 0, 1, onExpand, validItems, { onRatioResolved: applySingleRatio, mediaPriority }));
    }
    return single;
  }

  if (validItems.length === 2 && !forceCarousel) {
    const pair = doc.createElement('div');
    pair.className = 'post-media-grid post-media-pair post-media-count-2';
    const ratios = validItems.map((it) => getItemAspectRatio(it));
    const dims = validItems.map((it) => [Number.parseInt(it?.width, 10) || 0, Number.parseInt(it?.height, 10) || 0]);
    const slots = [];

    const syncPairRatios = () => {
      for (let i = 0; i < slots.length; i += 1) {
        const r = ratios[i];
        const [w, h] = dims[i];
        if (!Number.isFinite(r) || r <= 0) continue;
        slots[i].style.setProperty('--media-ratio', r.toFixed(4));
        slots[i].style.setProperty('--slot-aspect', w > 0 && h > 0 ? `${w} / ${h}` : `${r.toFixed(4)} / 1`);
      }
      if (Number.isFinite(ratios[0]) && ratios[0] > 0 && Number.isFinite(ratios[1]) && ratios[1] > 0) {
        pair.dataset.hasRatios = 'true';
        pair.style.setProperty('--pair-ratio-sum', (ratios[0] + ratios[1]).toFixed(4));
      }
    };

    validItems.forEach((item, idx) => {
      const slot = doc.createElement('div');
      slot.className = 'post-media-pair-slot';
      const el = buildMediaElement(doc, item, idx, 2, onExpand, validItems, {
        mediaPriority,
        onRatioResolved: (r, w, h) => {
          ratios[idx] = r;
          if (w > 0 && h > 0) dims[idx] = [w, h];
          syncPairRatios();
        },
      });
      slot.appendChild(el);
      slots.push(slot);
      pair.appendChild(slot);
    });
    syncPairRatios();
    return pair;
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
  const slideRatios = validItems.map((it) => getItemAspectRatio(it));
  const slideDims = validItems.map((it) => [Number.parseInt(it?.width, 10) || 0, Number.parseInt(it?.height, 10) || 0]);

  const syncCarouselSlideRatios = () => {
    for (let i = 0; i < slides.length; i += 1) {
      const r = slideRatios[i];
      const [w, h] = slideDims[i];
      if (!Number.isFinite(r) || r <= 0) continue;
      slides[i].style.setProperty('--slide-aspect', w > 0 && h > 0 ? `${w} / ${h}` : `${r.toFixed(4)} / 1`);
    }
  };

  validItems.forEach((item, idx) => {
    const slide = doc.createElement('div');
    slide.className = 'post-carousel-slide';
    slide.setAttribute('role', 'group');
    slide.setAttribute('aria-roledescription', 'slide');
    slide.setAttribute('aria-label', `${idx + 1} of ${total}`);
    slide.dataset.markerName = `Go to image ${idx + 1}`;
    slide.appendChild(
      buildMediaElement(doc, item, idx, total, onExpand, validItems, {
        mediaPriority,
        onRatioResolved: (r, w, h) => {
          slideRatios[idx] = r;
          if (w > 0 && h > 0) slideDims[idx] = [w, h];
          syncCarouselSlideRatios();
        },
      })
    );
    slides.push(slide);
    track.appendChild(slide);
  });
  syncCarouselSlideRatios();

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

  const hasTrackLayout = () => {
    const firstLeft = typeof slides[0]?.offsetLeft === 'number' ? slides[0].offsetLeft : 0;
    return slides.length > 1 && typeof slides[1]?.offsetLeft === 'number' && slides[1].offsetLeft > firstLeft;
  };

  const readTrackIndex = () => {
    if (!hasTrackLayout()) return pendingIndex ?? settledIndex;
    const firstLeft = slides[0].offsetLeft;
    const maxScroll = Math.max(0, (track.scrollWidth || 0) - (track.clientWidth || 0));
    const curScroll = Number(track.scrollLeft || 0);
    if (maxScroll > 0 && curScroll >= maxScroll - 2) {
      return total - 1;
    }
    let closestIdx = 0;
    let closestDist = Infinity;
    for (let i = 0; i < slides.length; i += 1) {
      const slideOffset = Math.max(0, (slides[i]?.offsetLeft || 0) - firstLeft);
      const dist = Math.abs(slideOffset - curScroll);
      if (dist < closestDist) {
        closestDist = dist;
        closestIdx = i;
      }
    }
    return Math.max(0, Math.min(total - 1, closestIdx));
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
    const rawTargetLeft = hasTrackLayout()
      ? Math.max(0, (slides[clamped]?.offsetLeft || 0) - firstLeft)
      : clamped * (track.clientWidth || 0);
    const maxScroll = Math.max(0, (track.scrollWidth || 0) - (track.clientWidth || 0));
    const targetLeft = maxScroll > 0 ? Math.min(rawTargetLeft, maxScroll) : rawTargetLeft;
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

export function createPostMediaGrid(media = [], { onExpand, sensitiveWarning = '', forceCarousel = false, mediaPriority = 'lazy' } = {}) {
  const doc = globalThis.document;
  const validItems = (Array.isArray(media) ? media : []).filter((item) => item && (item.url || item.previewUrl || item.hlsUrl));
  const gridEl = buildRawMediaGrid(doc, validItems, onExpand, { forceCarousel, mediaPriority });
  const warningText = String(sensitiveWarning || '').trim();
  if (!warningText || validItems.length === 0) {
    return gridEl;
  }
  return wrapSensitiveMediaGrid(doc, gridEl, warningText);
}

export function createComposerMediaEditor(attachments = [], { onRemove, sensitive = false } = {}) {
  const doc = globalThis.document;
  const isSensitive = Boolean(sensitive);
  const strip = doc.createElement('div');
  strip.className = `composer-media-strip${isSensitive ? ' is-sensitive' : ''}`;

  for (const att of attachments) {
    const card = doc.createElement('div');
    card.className = `composer-media-card${attachments.length === 1 ? ' is-single' : ''}${isSensitive ? ' is-sensitive' : ''}`;

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
        img.alt = att.altText || 'Attached media';
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
