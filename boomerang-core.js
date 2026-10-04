/* Shared, deterministic animation planning. No DOM, network or encoding work. */
export const MAX_VIDEO_PIXELS = 16_777_216;
export const MAX_VIDEO_BYTES = 128 * 1024 * 1024;
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

export function isPlane(snapshot, focus) {
  return Boolean(snapshot.params.advanced && snapshot.mode !== 'hue' && snapshot.params.planes?.[focus - 1]?.enabled);
}
export function currentPosition(snapshot, focus) {
  return isPlane(snapshot, focus) ? snapshot.params.planes[focus - 1].slide : snapshot.params[focus === 2 ? 'center2' : 'center'];
}
export function endpointBounds(snapshot, focus) { return isPlane(snapshot, focus) ? [-200, 200] : [0, 100]; }
export function sweepEndpoints(snapshot, focus) {
  if (!isPlane(snapshot, focus)) return [0, 100];
  const p = snapshot.params.planes[focus - 1], yaw = p.yaw * Math.PI / 180, pitch = p.pitch * Math.PI / 180;
  const n = [Math.sin(yaw) * Math.cos(pitch), -Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch)];
  const a = snapshot.width / snapshot.height, sx = Math.min(1, a), sy = Math.min(1, 1 / a);
  const c = n[0] * (p.pivot.x - .5) * sx + n[1] * (.5 - p.pivot.y) * sy + n[2] * (p.pivot.depth / 100 - .5);
  const r = (Math.abs(n[0]) * sx + Math.abs(n[1]) * sy + Math.abs(n[2])) / 2;
  return [(-r - c) * 100, (r - c) * 100].map(x => Math.round(x * 10) / 10);
}
export function bounceAt(phase, from, to, motion = 'ease') {
  // Periodic at the seam; sample [0,1), never append another copy of frame 0.
  const t = ((phase % 1) + 1) % 1;
  const u = motion === 'linear' ? 1 - Math.abs(2 * t - 1) : (1 - Math.cos(2 * Math.PI * t)) / 2;
  return from + (to - from) * u;
}
export function frameParams(snapshot, settings, phase) {
  const p = structuredClone(snapshot.params), value = bounceAt(phase, settings.from, settings.to, settings.motion);
  if (isPlane(snapshot, settings.focus)) p.planes[settings.focus - 1].slide = value;
  else p[settings.focus === 2 ? 'center2' : 'center'] = value;
  return p;
}
export function videoPlan(snapshot, input) {
  const width = snapshot.width, height = snapshot.height;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) throw new Error('Load a depth map first.');
  const s = { ...input };
  if (![1, 2].includes(s.focus) || (s.focus === 2 && !snapshot.params.secondEnabled)) throw new Error('Enable Focus B before animating it.');
  const [lo, hi] = endpointBounds(snapshot, s.focus);
  for (const k of ['from', 'to']) if (!Number.isFinite(s[k]) || s[k] < lo || s[k] > hi) throw new Error(`The ${k} position must be between ${lo}% and ${hi}%.`);
  if (Math.abs(s.to - s.from) < .01) throw new Error('Choose two different endpoint positions.');
  if (!Number.isFinite(s.duration) || s.duration < .5 || s.duration > 30) throw new Error('Use a total loop duration between 0.5 and 30 seconds.');
  if (![24, 30, 60].includes(s.fps)) throw new Error('Choose 24, 30 or 60 frames per second.');
  if (!['ease', 'linear'].includes(s.motion) || !['avc', 'hevc'].includes(s.codec)) throw new Error('Invalid animation or codec setting.');
  if (!['native', '3840', '2560', '1920', '1280', '960'].includes(s.resolution)) throw new Error('Invalid video resolution.');
  if (!['standard', 'high'].includes(s.quality)) throw new Error('Invalid quality setting.');
  const scale = s.resolution === 'native' ? 1 : Math.min(1, Number(s.resolution) / Math.max(width, height));
  const contentWidth = Math.max(1, Math.round(width * scale)), contentHeight = Math.max(1, Math.round(height * scale));
  // Pad right/bottom, never crop or squeeze the source to satisfy 4:2:0 encoders.
  const codedWidth = contentWidth + contentWidth % 2, codedHeight = contentHeight + contentHeight % 2;
  if (codedWidth * codedHeight > MAX_VIDEO_PIXELS || codedWidth > 8192 || codedHeight > 8192) throw new Error('This first pass supports video frames up to 16 megapixels and 8,192 pixels per side. Select a smaller output size; PNG export is unchanged.');
  const frames = Math.max(2, 2 * Math.round(s.duration * s.fps / 2));
  const duration = frames / s.fps;
  const bitrate = Math.round(clamp(codedWidth * codedHeight * s.fps * (s.quality === 'high' ? .24 : .12) * (s.codec === 'hevc' ? .7 : 1), 1_000_000, 100_000_000));
  if (bitrate * duration / 8 > MAX_VIDEO_BYTES * .85) throw new Error('This clip may exceed the 128 MB in-memory export limit. Reduce duration, quality, frame rate or resolution.');
  return { ...s, width: contentWidth, height: contentHeight, codedWidth, codedHeight, frames, duration, bitrate, native: scale === 1, padded: contentWidth !== codedWidth || contentHeight !== codedHeight };
}

export function codecCandidates(plan) {
  const { codedWidth: width, codedHeight: height, fps, bitrate } = plan;
  if (plan.codec === 'hevc') {
    const levels = [[93,983040,33177600,6000000],[120,2228224,66846720,12000000],[123,2228224,133693440,20000000],[150,8912896,267386880,25000000],[153,8912896,534773760,40000000],[156,8912896,1069547520,60000000],[180,35651584,1069547520,60000000],[183,35651584,2139095040,120000000],[186,35651584,4278190080,240000000]];
    return levels.filter(([,sz,rate,bps]) => width * height <= sz && width * height * fps <= rate && bitrate <= bps).slice(0, 2).map(([l]) => `hvc1.1.6.L${l}.B0`);
  }
  const mb = Math.ceil(width / 16) * Math.ceil(height / 16);
  const levels = [[30,1620,40500,10000000],[31,3600,108000,14000000],[32,5120,216000,20000000],[40,8192,245760,20000000],[41,8192,245760,50000000],[42,8704,522240,50000000],[50,22080,589824,135000000],[51,36864,983040,240000000],[52,36864,2073600,240000000],[60,139264,4177920,240000000],[61,139264,8355840,480000000],[62,139264,16711680,800000000]];
  return levels.filter(([,sz,rate,bps]) => mb <= sz && mb * fps <= rate && bitrate <= bps && Math.max(Math.ceil(width/16), Math.ceil(height/16)) <= Math.sqrt(sz * 8)).slice(0, 2).flatMap(([l]) => ['6400', '4d40', '4200'].map(profile => `avc1.${profile}${l.toString(16).padStart(2, '0')}`));
}
export async function supportedConfig(plan) {
  if (typeof VideoEncoder === 'undefined') return null;
  for (const codec of codecCandidates(plan)) {
    const config = { codec, width: plan.codedWidth, height: plan.codedHeight, bitrate: plan.bitrate, framerate: plan.fps, bitrateMode: 'variable', latencyMode: 'realtime', hardwareAcceleration: 'no-preference' };
    if (plan.codec === 'avc') config.avc = { format: 'avc' };
    else config.hevc = { format: 'hevc' };
    try {
      const result = await VideoEncoder.isConfigSupported(config);
      if (result.supported) return config;
    } catch (_) { /* Try another standard profile/level, never another size. */ }
  }
  return null;
}
