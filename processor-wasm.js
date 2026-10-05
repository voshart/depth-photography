/* Dependency-free adapter. One reusable aligned arena per processor instance. */
import { createProcessor } from './processor.js?v=20261005-wasm1';

export function createWasmKernels(instance) {
  const e = instance.exports;
  function arena(parts) {
    const offsets = []; let size = 0;
    for (const part of parts) { size = Math.ceil(size / 8) * 8; offsets.push(size); size += part.byteLength; }
    const ptr = e.reserve(size), memory = new Uint8Array(e.memory.buffer);
    parts.forEach((part, i) => memory.set(new Uint8Array(part.buffer, part.byteOffset, part.byteLength), ptr + offsets[i]));
    return offsets.map(offset => ptr + offset);
  }
  function copy(ptr, target) { target.set(new Uint8Array(e.memory.buffer, ptr, target.byteLength)); return target; }
  return {
    spatial(data, depth, table, p, a, b, width, height, offsetY, inPlace) {
      const config = Float64Array.of(...a.normal, a.constant, ...b.normal, b.constant,
        a.sx, a.sy, p.width / 200, p.width2 / 200,
        p.profile === 'mask' ? 1 : p.profile === 'ramp' ? 2 : 0,
        p.softness, p.softness2, p.contrast, p.lift, p.background / 100,
        Number(p.invert), Number(p.reverse), Number(p.secondEnabled));
      const [ptr, d, t, c] = arena([data, depth, table, config]);
      e.spatial(ptr, d, t, c, width, height, data.length / (4 * width), offsetY);
      return copy(ptr, inPlace ? data : new Uint8ClampedArray(data.length));
    }
  };
}

export async function createAcceleratedProcessor(load = async () => {
  const response = await fetch(new URL('./wasm/depth-kernels.wasm?v=20261005-wasm1', import.meta.url));
  if (!response.ok) throw new Error('WASM processor unavailable');
  // ArrayBuffer also works on static hosts that lack application/wasm MIME.
  return WebAssembly.instantiate(await response.arrayBuffer());
}) {
  try { const { instance } = await load(); return createProcessor(createWasmKernels(instance)); }
  catch { return createProcessor(); }
}
