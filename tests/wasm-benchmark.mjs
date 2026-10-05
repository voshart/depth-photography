import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { createProcessor } from '../processor.js';
import { createAcceleratedProcessor } from '../processor-wasm.js';
const original=process.argv[2] ? (await import(pathToFileURL(process.argv[2]))).createProcessor() : null;
const js=createProcessor(),wasm=await createAcceleratedProcessor(()=>readFile(new URL('../wasm/depth-kernels.wasm',import.meta.url)).then(b=>WebAssembly.instantiate(b)));
if(wasm.backend!=='rust-wasm')throw new Error('WASM did not load');
const w=1500,h=1000,n=w*h,data=new Uint8ClampedArray(n*4),depth=new Uint16Array(n),texture=new Uint8Array(n*2);
for(let i=0;i<n;i++){depth[i]=(Math.imul(i,7919)>>>0)%16384;data[i*4+3]=255;texture[i*2]=i%256;texture[i*2+1]=255;}
const params={center:25,center2:70,width:18,width2:23,softness:94,softness2:75,secondEnabled:true,contrast:1.2,lift:1,background:0,profile:'band',invert:false,reverse:false,advanced:true,
 planes:[{enabled:true,yaw:37,pitch:-15,slide:4,pivot:{x:.4,y:.6,depth:25}},{enabled:true,yaw:-45,pitch:15,slide:5,pivot:{x:.4,y:.8,depth:70}}]};
function measure(fn){for(let i=0;i<4;i++)fn();const runs=[];for(let i=0;i<15;i++){const start=performance.now();fn();runs.push(performance.now()-start);}runs.sort((a,b)=>a-b);return runs[7];}
for(const [label,run] of [
 ['flat focus',p=>p.applyFocus(data,depth,{...params,advanced:false},'gray',w,h,0,true)],
 ['rotated planes',p=>p.applyFocus(data,depth,params,'gray',w,h,0,true)],
 ['detail overlay',p=>p.blendDetail(data,texture,{enabled:true,opacity:63,blend:'overlay'},true)],
 ['rotated planes + two details',p=>{p.applyFocus(data,depth,params,'gray',w,h,0,true);for(let i=0;i<2;i++)p.blendDetail(data,texture,{enabled:true,opacity:63,blend:'overlay'},true);}],
 ['grayscale',p=>p.grayscale(data)]
]){const baseline=original?measure(()=>run(original)):null;const a=measure(()=>run(js)),b=measure(()=>run(wasm));console.log(`${label}: ${baseline===null?'':`original JS ${baseline.toFixed(2)} ms, `}JS ${a.toFixed(2)} ms, WASM ${b.toFixed(2)} ms, ${(a/b).toFixed(2)}x`);}
