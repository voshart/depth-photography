/* Native-size animation cache. Decode and align once; never store raw frame lists. */
import { createProcessor } from './processor.js';
const pause = () => new Promise(resolve => setTimeout(resolve, 0));
function aligned(ctx, image, w, h, fit, y, rows) {
  ctx.clearRect(0, 0, w, rows);
  ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
  let dw = w, dh = h;
  if (fit !== 'stretch') {
    const scale = fit === 'cover' ? Math.max(w / image.width, h / image.height) : Math.min(w / image.width, h / image.height);
    dw = image.width * scale; dh = image.height * scale;
  }
  ctx.drawImage(image, (w - dw) / 2, (h - dh) / 2 - y, dw, dh);
  return ctx.getImageData(0, 0, w, rows).data;
}
export async function compileInputs(snapshot, plan, images, progress = () => {}) {
  const p = createProcessor(), { width: w, height: h } = plan, count = w * h;
  const depth = new Uint16Array(count), alpha = new Uint8Array(count);
  const details = images.details.map(image => image ? new Uint8Array(count * 2) : null);
  const rows = Math.max(1, Math.min(128, Math.floor(262144 / w)));
  const canvas = new OffscreenCanvas(w, rows), ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('The browser could not allocate the animation canvas. Select a smaller size.');
  try {
    for (let y = 0; y < h; y += rows) {
      const hh = Math.min(rows, h - y), offset = y * w;
      const data = aligned(ctx, images.source, w, h, 'stretch', y, hh);
      let values = p.decode(data, snapshot.mode);
      for (let i = 0; i < values.length; i++) alpha[offset + i] = data[i * 4 + 3];
      if (images.depth2) {
        const other = aligned(ctx, images.depth2, w, h, snapshot.depthMix.fit, y, hh);
        values = p.blendDepth(values, p.decode(other, snapshot.depth2Mode), other, snapshot.depthMix);
      }
      depth.set(values, offset);
      for (let n = 0; n < 2; n++) if (images.details[n]) {
        const texture = p.grayscale(aligned(ctx, images.details[n], w, h, snapshot.details[n].fit, y, hh));
        for (let i = 0; i < hh * w; i++) {
          details[n][(offset + i) * 2] = texture[i * 4];
          details[n][(offset + i) * 2 + 1] = texture[i * 4 + 3];
        }
      }
      progress((y + hh) / h);
      await pause(); // Allows cancellation messages and progress delivery during preparation.
    }
    return { processor: p, depth, alpha, details, frame: new ImageData(w, h) };
  } finally {
    canvas.width = canvas.height = 1;
    for (const image of [images.source, images.depth2, ...images.details]) image?.close();
  }
}
export function renderFrame(cache, snapshot, params, plan, flatten = true) {
  const data = cache.frame.data, p = cache.processor;
  for (let i = 0; i < cache.alpha.length; i++) data[i * 4 + 3] = cache.alpha[i];
  p.applyFocus(data, cache.depth, params, snapshot.mode, plan.width, plan.height, 0, true);
  for (let i = 0; i < 2; i++) p.blendDetail(data, cache.details[i], snapshot.details[i], true);
  if (flatten) for (let i = 0; i < data.length; i += 4) {
    data[i] = data[i + 1] = data[i + 2] = Math.round(data[i] * data[i + 3] / 255); data[i + 3] = 255;
  }
  return cache.frame;
}
export function paintFrame(ctx, frame, plan) {
  ctx.putImageData(frame, 0, 0);
  // One-pixel edge extension for odd source dimensions, with no resizing/cropping.
  if (plan.codedWidth > plan.width) ctx.drawImage(ctx.canvas, plan.width - 1, 0, 1, plan.height, plan.width, 0, 1, plan.height);
  if (plan.codedHeight > plan.height) ctx.drawImage(ctx.canvas, 0, plan.height - 1, plan.codedWidth, 1, 0, plan.height, plan.codedWidth, 1);
}
