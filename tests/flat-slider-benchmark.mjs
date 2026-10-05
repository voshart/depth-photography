/* Successive focus positions, retained preview inputs, and full request/response copies. */
import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { createProcessor } from '../processor.js';
import { createAcceleratedProcessor } from '../processor-wasm.js';
const load=()=>readFile(new URL('../wasm/depth-kernels.wasm',import.meta.url)).then(b=>WebAssembly.instantiate(b));
const params={center:25,center2:70,width:18,width2:23,softness:94,softness2:75,secondEnabled:true,contrast:1.2,lift:1,background:0,profile:'band',invert:false,reverse:false,advanced:false};
function stats(xs){const sorted=xs.slice().sort((a,b)=>a-b);return {median:sorted[Math.floor(xs.length*.5)].toFixed(2),p95:sorted[Math.floor(xs.length*.95)].toFixed(2),max:sorted.at(-1).toFixed(2)};}
for(const [w,h] of [[960,640],[1500,1000]]) {
 const count=w*h,data=new Uint8ClampedArray(count*4),depth=new Uint16Array(count);
 for(let i=0;i<count;i++){const v=(Math.imul(i,7919)>>>0)%256;data.set([v,v,v,i%17?255:128],i*4);depth[i]=Math.round(v/255*16382);}
 const engines=[['JS',createProcessor()],['WASM',await createAcceleratedProcessor(load)]];
 for(const [name,p] of engines) {
  p.process('prepare',{buffer:data.slice().buffer,width:w,height:h,encoding:'gray'});
  const start=performance.now();p.process('render',{params});const first=performance.now()-start;
  for(let frame=0;frame<12;frame++)p.process('render',{params:{...params,center:frame*100/12}});
  const times=[];
  for(let frame=0;frame<120;frame++){
   const start=performance.now();
   p.process('render',{params:{...params,center:frame*100/119}});
   times.push(performance.now()-start);
  }
  console.log(`${w}x${h} ${name} full slider render: first ${first.toFixed(2)} ms, ${JSON.stringify(stats(times))}`);
  const one=[];
  for(let frame=0;frame<120;frame++){
   const start=performance.now();
   p.applyFocus(data,depth,{...params,center:frame*100/119},'gray',w,h);
   one.push(performance.now()-start);
  }
  console.log(`${w}x${h} ${name} uncached apply: ${JSON.stringify(stats(one))}`);
 }
}
