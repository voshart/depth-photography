import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { createAcceleratedProcessor } from '../processor-wasm.js';
const load=()=>readFile(new URL('../wasm/depth-kernels.wasm',import.meta.url)).then(b=>WebAssembly.instantiate(b));
const baseline=process.argv[2]?await import(pathToFileURL(process.argv[2])):null;
const params={center:25,center2:70,width:18,width2:23,softness:94,softness2:75,secondEnabled:true,contrast:1.2,lift:1,background:0,profile:'band',invert:false,reverse:false,advanced:false};
const w=1500,h=1000,n=w*h,source=new Uint8ClampedArray(n*4),texture=new Uint8ClampedArray(n*4);
for(let i=0;i<n;i++){const v=(Math.imul(i,7919)>>>0)%256,d=(Math.imul(i,3571)>>>0)%256;source.set([v,v,v,255],i*4);texture.set([d,d,d,255],i*4);}
for(const alpha of [255,128])for(const layers of [0,1,2]) {
 const engines=[];
 if(baseline)engines.push(['before',await baseline.createAcceleratedProcessor(load)]);
 engines.push(['after',await createAcceleratedProcessor(load)]);
 for(const [name,p] of engines){
  for(let i=0;i<n;i++)texture[i*4+3]=alpha;
  p.process('prepare',{buffer:source.slice().buffer,width:w,height:h,encoding:'gray'});
  for(let index=0;index<layers;index++)p.process('prepareDetail',{index,buffer:texture.slice().buffer});
  const details=[{enabled:layers>0,opacity:63,blend:'overlay'},{enabled:layers>1,opacity:35,blend:'multiply'}];
  const times=[];let outputBuffer=null;
  for(let frame=0;frame<80;frame++){
   const start=performance.now();const result=p.process('render',{params:{...params,center:frame*100/79},details,outputBuffer});outputBuffer=result.buffer;
   if(frame>=12)times.push(performance.now()-start);
  }
  times.sort((a,b)=>a-b);console.log(`${name}, ${layers} details, alpha ${alpha}: median ${times[Math.floor(times.length/2)].toFixed(2)} ms, p95 ${times[Math.floor(times.length*.95)].toFixed(2)} ms`);
 }
}
