import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createProcessor } from '../processor.js';
import { createAcceleratedProcessor } from '../processor-wasm.js';
const load=()=>readFile(new URL('../wasm/depth-kernels.wasm',import.meta.url)).then(b=>WebAssembly.instantiate(b));
const w=257,h=129,n=w*h,source=new Uint8ClampedArray(n*4),detail=new Uint8ClampedArray(n*4);
for(let i=0;i<n;i++){source.set([i%256,i%256,i%256,i%13?255:128],i*4);detail.set([255-i%256,255-i%256,255-i%256,255],i*4);}
const params={center:25,center2:70,width:18,width2:23,softness:94,softness2:75,secondEnabled:true,contrast:1.2,lift:1,background:12,profile:'band',invert:false,reverse:false,advanced:false,
 planes:[{enabled:true,yaw:37,pitch:-15,slide:4,pivot:{x:.4,y:.6,depth:25}},{enabled:true,yaw:-45,pitch:15,slide:5,pivot:{x:.4,y:.8,depth:70}}]};
for(const backend of [createProcessor(),await createAcceleratedProcessor(load)]){
 const reference=createProcessor();
 for(const engine of [backend,reference]){
  engine.process('prepare',{buffer:source.slice().buffer,width:w,height:h,encoding:'gray'});
  for(let index=0;index<2;index++)engine.process('prepareDetail',{index,buffer:detail.slice().buffer});
 }
 let outputBuffer=new ArrayBuffer(source.byteLength);
 for(let frame=0;frame<24;frame++){
  const payload={params:{...params,center:frame*100/23,advanced:frame%3===0},details:[{enabled:true,opacity:frame%2?35:63,blend:'overlay'},{enabled:true,opacity:35,blend:'multiply'}]};
  // Main -> worker transfer detaches the old displayed ImageData backing buffer.
  const received=structuredClone({outputBuffer},{transfer:[outputBuffer]});assert.equal(outputBuffer.byteLength,0);
  const result=backend.process('render',{...payload,...received});
  assert.equal(result.buffer,received.outputBuffer);
  assert.deepEqual(new Uint8Array(result.buffer),new Uint8Array(reference.process('render',payload).buffer));
  outputBuffer=structuredClone(result,{transfer:[result.buffer]}).buffer;
  assert.equal(result.buffer.byteLength,0);
  if(frame===6)for(const engine of [backend,reference])engine.process('prepareDetail',{index:1,buffer:source.slice().buffer});
 }
 assert.throws(()=>backend.process('render',{params,outputBuffer:new ArrayBuffer(4)}),/wrong size/);
}
console.log('PASS: transferred preview buffer reuse, flat/spatial alternation, opaque detail retention/replacement, changing blend settings, source alpha and wrong-size rejection');
