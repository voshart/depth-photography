import { videoPlan, frameParams, supportedConfig, MAX_VIDEO_BYTES } from './boomerang-core.js?v=20261004-3';
import { compileInputs, renderFrame, paintFrame } from './boomerang-render.js?v=20261005-wasm3';
import { VideoMp4 } from './mp4.js?v=20261004-4';

const timeout = (promise, ms, message) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(message)), ms);
  promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
});
let running = false;
self.onmessage = async ({ data }) => {
  if (data.type === 'probe') {
    const results = {};
    for (const codec of ['avc', 'hevc']) {
      try { results[codec] = await supportedConfig(videoPlan(data.snapshot, { ...data.settings, codec })); }
      catch (_) { results[codec] = null; }
    }
    self.postMessage({ type: 'support', results }); return;
  }
  if (data.type !== 'start' || running) return;
  running = true;
  let encoder = null, canvas = null, images = data.images, fatal = null;
  try {
    const { snapshot } = data, plan = videoPlan(snapshot, data.settings);
    const config = await supportedConfig(plan);
    if (!config) throw new Error(`${plan.codec === 'avc' ? 'H.264' : 'H.265'} encoding is not available at this size and frame rate. Try H.264, a smaller size, or another browser.`);
    const movie = new VideoMp4({ width: plan.codedWidth, height: plan.codedHeight, fps: plan.fps, frames: plan.frames, codec: plan.codec, maxBytes: MAX_VIDEO_BYTES });
    encoder = new VideoEncoder({
      output(chunk, meta) { try { movie.add(chunk, meta); } catch (error) { fatal = error; } },
      error(error) { fatal = new Error(`Video encoding failed: ${error.message}. Try H.264 or a smaller output size.`); }
    });
    encoder.configure(config);
    // The renderer uses the same focus/detail functions as the still exporter.
    self.postMessage({ type: 'progress', stage: 'prepare', value: 0 });
    const cache = await compileInputs(snapshot, plan, images, value => self.postMessage({ type: 'progress', stage: 'prepare', value }));
    images = null;
    canvas = new OffscreenCanvas(plan.codedWidth, plan.codedHeight);
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('The browser could not allocate the video frame. Select a smaller size.');
    const started = performance.now();
    for (let k = 0; k < plan.frames; k++) {
      if (fatal) throw fatal;
      if (encoder.encodeQueueSize >= 2) {
        await timeout(new Promise(resolve => encoder.addEventListener('dequeue', resolve, { once: true })), 30000, 'The video encoder stalled. Try a smaller size or another browser.');
        if (fatal) throw fatal;
      }
      paintFrame(ctx, renderFrame(cache, snapshot, frameParams(snapshot, plan, k / plan.frames), plan), plan);
      const timestamp = Math.round(k * 1e6 / plan.fps), end = Math.round((k + 1) * 1e6 / plan.fps);
      const frame = new VideoFrame(canvas, { timestamp, duration: end - timestamp });
      // Android hardware encoders can emit a fresh decoderConfig at a later keyframe.
      // The MP4 writer now starts a new sample-description chunk when that happens.
      try { encoder.encode(frame, { keyFrame: k % (plan.fps * 2) === 0 }); } finally { frame.close(); }
      // Fail early on drivers that claim support but cannot encode the first frame.
      if (k === 0) await timeout(encoder.flush(), 30000, 'The browser could not encode the first frame. Try a smaller size.');
      if (fatal) throw fatal;
      self.postMessage({ type: 'progress', stage: 'render', value: (k + 1) / plan.frames, frame: k + 1, frames: plan.frames, elapsed: (performance.now() - started) / 1000 });
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    self.postMessage({ type: 'progress', stage: 'finalize', value: 0 });
    await timeout(encoder.flush(), 60000, 'The video encoder did not finish. No partial clip was saved.');
    if (fatal) throw fatal;
    encoder.close(); encoder = null;
    const blob = movie.finish();
    self.postMessage({ type: 'done', blob, plan, codec: config.codec });
  } catch (error) {
    self.postMessage({ type: 'error', message: error?.message || 'Video export failed. Try a smaller size.' });
  } finally {
    if (encoder && encoder.state !== 'closed') encoder.close();
    if (canvas) canvas.width = canvas.height = 1;
    if (images) for (const image of [images.source, images.depth2, ...(images.details || [])]) image?.close();
    running = false;
  }
};
