/* Dependency-free adapter. One reusable aligned arena per processor instance. */
import { createProcessor } from './processor.js?v=20261005-wasm3';

export function createWasmKernels(instance) {
  const e = instance.exports;
  if(!(e.memory instanceof WebAssembly.Memory)||['reserve','flat','spatial','reserve_detail','reserve_texture','detail_lookup'].some(name=>typeof e[name]!=='function'))
    throw new Error('The WASM processor is out of date.');
  // Retention is opt-in only for immutable decoded depth and source alpha.
  // UI prepare/mix operations replace these arrays; public calls copy by default.
  // Spatial kernels or an arena resize invalidate the retained layout.
  let retained=null;
  const detailSlots=[null,null];let nextDetailSlot=0;
  const configFor=p=>[0,0,0,0,0,0,0,0,0,0,p.width/200,p.width2/200,
    p.profile==='mask'?1:p.profile==='ramp'?2:0,p.softness,p.softness2,
    p.contrast,p.lift,p.background/100,Number(p.invert),Number(p.reverse),Number(p.secondEnabled)];
  function arena(parts, retainInputs=false) {
    const offsets = []; let size = 0;
    for (const part of parts) { size = Math.ceil(size / 8) * 8; offsets.push(size); size += part.byteLength; }
    const ptr = e.reserve(size), memory = new Uint8Array(e.memory.buffer);
    const reuse=retainInputs && retained?.data===parts[0] && retained?.depth===parts[1]
      && retained.ptr===ptr && retained.buffer===e.memory.buffer && retained.size===size;
    parts.forEach((part, i) => { if(reuse && i<2)return; memory.set(new Uint8Array(part.buffer, part.byteOffset, part.byteLength), ptr + offsets[i]); });
    retained=retainInputs?{data:parts[0],depth:parts[1],ptr,buffer:e.memory.buffer,size}:null;
    return offsets.map(offset => ptr + offset);
  }
  function copy(ptr, target) { target.set(new Uint8Array(e.memory.buffer, ptr, target.byteLength)); return target; }
  return {
    detail(base,texture,table,compact,opacity,overlay,retainTexture) {
      let slot=retainTexture?detailSlots.findIndex(s=>s?.texture===texture):-1;
      if(slot<0){slot=nextDetailSlot;nextDetailSlot=1-nextDetailSlot;}
      const lutOffset=Math.ceil(base.byteLength/8)*8;
      // One output workspace shared by both layers, two retained texture slots.
      const ptr=e.reserve_detail(lutOffset+table.byteLength);
      const texPtr=e.reserve_texture(texture.byteLength,slot);
      const memory=new Uint8Array(e.memory.buffer),saved=detailSlots[slot];
      memory.set(new Uint8Array(base.buffer,base.byteOffset,base.byteLength),ptr);
      if(!retainTexture||saved?.texture!==texture||saved.ptr!==texPtr||saved.buffer!==e.memory.buffer)
        memory.set(new Uint8Array(texture.buffer,texture.byteOffset,texture.byteLength),texPtr);
      memory.set(table,ptr+lutOffset);
      detailSlots[slot]=retainTexture?{texture,ptr:texPtr,buffer:e.memory.buffer}:null;
      e.detail_lookup(ptr,texPtr,ptr+lutOffset,base.length/4,compact?2:4,opacity,Number(overlay));
      return copy(ptr,base);
    },
    flat(data,depth,p,mode,inPlace,retainInputs,outputTarget) {
      const config=Float64Array.from([...configFor(p),p.center/100,p.center2/100,Number(mode==='hue')]);
      const [ptr,d,c]=arena([data,depth,config],retainInputs);
      e.flat(ptr,d,c,data.length/4);
      return copy(ptr,inPlace?data:outputTarget||new Uint8ClampedArray(data.length));
    },
    spatial(data, depth, table, p, a, b, width, height, offsetY, inPlace, outputTarget) {
      const config = Float64Array.of(...a.normal, a.constant, ...b.normal, b.constant,
        a.sx, a.sy, p.width / 200, p.width2 / 200,
        p.profile === 'mask' ? 1 : p.profile === 'ramp' ? 2 : 0,
        p.softness, p.softness2, p.contrast, p.lift, p.background / 100,
        Number(p.invert), Number(p.reverse), Number(p.secondEnabled));
      const [ptr, d, t, c] = arena([data, depth, table, config]);
      e.spatial(ptr, d, t, c, width, height, data.length / (4 * width), offsetY);
      return copy(ptr, inPlace ? data : outputTarget||new Uint8ClampedArray(data.length));
    }
  };
}

export async function createAcceleratedProcessor(load = async () => {
  const response = await fetch(new URL('./wasm/depth-kernels.wasm?v=20261005-wasm3', import.meta.url));
  if (!response.ok) throw new Error('WASM processor unavailable');
  // ArrayBuffer also works on static hosts that lack application/wasm MIME.
  return WebAssembly.instantiate(await response.arrayBuffer());
}) {
  try { const { instance } = await load(); return createProcessor(createWasmKernels(instance)); }
  catch { return createProcessor(); }
}
