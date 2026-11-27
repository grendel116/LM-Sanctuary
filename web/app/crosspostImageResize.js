/**
 * Cross-post image shrinking. Bluesky caps image blobs at 1,000,000 bytes, the
 * strictest limit among connected networks, so every compose attachment is
 * brought under one budget (with headroom, matching the 950_000 thumb budget
 * already used in web/adapters/bluesky/index.js) before fan-out.
 */

export const CROSSPOST_IMAGE_MAX_BYTES = 950_000;
const CROSSPOST_IMAGE_MAX_DIMENSION = 2048;
const JPEG_QUALITY_LADDER = [0.85, 0.7, 0.55];
const MAX_ENCODE_ATTEMPTS = 9;

export function shouldShrinkImageBlob(blob) {
  const type = String(blob?.type || '').toLowerCase();
  return Boolean(
    blob
    && typeof blob.size === 'number'
    && type.startsWith('image/')
    // Re-encoding a GIF through canvas destroys its animation; pass GIFs through.
    && type !== 'image/gif'
    && blob.size > CROSSPOST_IMAGE_MAX_BYTES,
  );
}

function loadImageElement(doc, blob) {
  if (typeof globalThis.URL?.createObjectURL !== 'function') {
    throw new Error('Image resize failed: object URLs unsupported in this environment.');
  }
  return new Promise((resolve, reject) => {
    const url = globalThis.URL.createObjectURL(blob);
    const img = doc.createElement('img');
    img.onload = () => {
      globalThis.URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      globalThis.URL.revokeObjectURL(url);
      reject(new Error('Image resize failed: could not decode image.'));
    };
    img.src = url;
  });
}

function encodeCanvasAsJpeg(canvas, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((out) => {
      if (out && out.size > 0) resolve(out);
      else reject(new Error('Image resize failed: JPEG encode produced no data.'));
    }, 'image/jpeg', quality);
  });
}

export async function shrinkImageBlobForCrosspost(blob) {
  if (!shouldShrinkImageBlob(blob)) return blob;

  const doc = globalThis.document;
  if (!doc?.createElement) {
    throw new Error('Image resize failed: canvas unavailable in this environment.');
  }

  const img = await loadImageElement(doc, blob);
  const srcW = Number(img.naturalWidth) || 0;
  const srcH = Number(img.naturalHeight) || 0;
  if (!srcW || !srcH) {
    throw new Error('Image resize failed: image has no dimensions.');
  }

  const canvas = doc.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Image resize failed: canvas 2d context unavailable.');
  }

  const dimensionCap = Math.min(1, CROSSPOST_IMAGE_MAX_DIMENSION / Math.max(srcW, srcH));
  let scale = dimensionCap;
  let qualityIdx = 0;
  for (let attempt = 0; attempt < MAX_ENCODE_ATTEMPTS; attempt += 1) {
    const w = Math.max(1, Math.round(srcW * scale));
    const h = Math.max(1, Math.round(srcH * scale));
    canvas.width = w;
    canvas.height = h;
    ctx.fillStyle = '#ffffff'; // JPEG has no alpha channel; flatten transparency onto white.
    ctx.fillRect(0, 0, w, h);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, w, h);

    const encoded = await encodeCanvasAsJpeg(canvas, JPEG_QUALITY_LADDER[qualityIdx]);
    if (encoded.size <= CROSSPOST_IMAGE_MAX_BYTES) return encoded;

    qualityIdx += 1;
    if (qualityIdx >= JPEG_QUALITY_LADDER.length) {
      qualityIdx = 0;
      scale *= 0.75;
    }
  }
  throw new Error('Image resize failed: could not compress image below platform limits.');
}
