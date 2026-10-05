import assert from 'node:assert/strict';
import { createProcessor } from '../processor.js';
import { createAcceleratedProcessor } from '../processor-wasm.js';
import { readFile } from 'node:fs/promises';
const p=createProcessor(),wasm=await createAcceleratedProcessor(()=>readFile(new URL('../wasm/depth-kernels.wasm',import.meta.url)).then(b=>WebAssembly.instantiate(b))),count=65536;
assert.equal(wasm.backend,'rust-wasm');
const rgba=new Uint8ClampedArray(count*4),texture=new Uint8ClampedArray(count*4),packed=new Uint8Array(count*2);
for(let b=0;b<256;b++)for(let d=0;d<256;d++){
 const i=b*256+d;rgba.set([b,b,b,i%37?255:0],i*4);texture.set([d,d,d,255],i*4);packed.set([d,255],i*2);
}
// A direct display-space compositing reference, independent of lookup construction.
function reference(base,texture,opacity,overlay,alpha){
 if(!alpha||!base[3])return [...base];
 const b=base[0]/255,d=texture/255,a=opacity*alpha/255;
 const blend=overlay?(b<=.5?2*b*d:1-2*(1-b)*(1-d)):b*d;
 const v=Math.round(Math.min(1,Math.max(0,b+a*(blend-b)))*255);
 return [v,v,v,base[3]];
}
for(const blend of ['multiply','overlay'])for(const opacity of [.5,15,35,63,100])for(const alpha of [0,17,128,255]){
 for(let i=0;i<count;i++){texture[i*4+3]=alpha;packed[i*2+1]=alpha;}
 const settings={enabled:true,opacity,blend},expected=new Uint8ClampedArray(rgba.length);
 for(let i=0;i<count;i++)expected.set(reference(rgba.subarray(i*4,i*4+4),texture[i*4],opacity/100,blend==='overlay',alpha),i*4);
 for(const engine of [p,wasm]) {
  assert.deepEqual(engine.blendDetail(rgba.slice(),texture.slice(),settings,false,true),expected);
  assert.deepEqual(engine.blendDetail(rgba.slice(),packed.slice(),settings,true,true),expected);
 }
}
console.log('PASS: all 65,536 intensity pairs at ten blend/opacity settings, four coverage alphas, source transparency, cache eviction and compact textures');
// Predominantly opaque textures still contain translucent edge pixels. This
// routes through Rust and checks its fractional-coverage arithmetic as well.
const edges=texture.slice(),edgeExpected=new Uint8ClampedArray(rgba.length);
for(let i=0;i<count;i++){
 edges[i*4+3]=i%10===0?128:i%17===0?17:255;
 edgeExpected.set(reference(rgba.subarray(i*4,i*4+4),edges[i*4],.63,true,edges[i*4+3]),i*4);
}
assert.deepEqual(wasm.blendDetail(rgba.slice(),edges,{enabled:true,opacity:63,blend:'overlay'},false,true),edgeExpected);
