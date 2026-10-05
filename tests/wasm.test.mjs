import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createProcessor } from '../processor.js';
import { createAcceleratedProcessor } from '../processor-wasm.js';
export const load = () => readFile(new URL('../wasm/depth-kernels.wasm', import.meta.url)).then(bytes => WebAssembly.instantiate(bytes));
const js=createProcessor(), wasm=await createAcceleratedProcessor(load);
assert.equal(wasm.backend,'rust-wasm');
assert.equal((await createAcceleratedProcessor(async()=>{throw new Error('fetch failed');})).backend,'javascript');
const w=257,h=129,n=w*h, data=new Uint8ClampedArray(n*4),texture=new Uint8ClampedArray(n*4),compact=new Uint8Array(n*2),depth=new Uint16Array(n);
let seed=5;
function random(){seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed;}
for(let i=0;i<n;i++) {
 depth[i]=random()%16384;
 for(let j=0;j<4;j++){data[i*4+j]=random()>>>24;texture[i*4+j]=random()>>>24;}
 if(i%19===0)data[i*4+3]=0;
 compact[i*2]=texture[i*4];compact[i*2+1]=texture[i*4+3];
}
assert.deepEqual(wasm.grayscale(data.slice()),js.grayscale(data.slice()));
for(const blend of ['multiply','overlay'])for(const opacity of [0,15,63,100])for(const packed of [false,true]) {
 const tex=packed?compact:texture, settings={enabled:true,opacity,blend};
 assert.deepEqual(wasm.blendDetail(data.slice(),tex,settings,packed),js.blendDetail(data.slice(),tex,settings,packed));
}
assert.throws(()=>wasm.blendDetail(data,texture.subarray(4),{enabled:true,opacity:10}),/aligned/);
const params={center:25,center2:70,width:18,width2:23,softness:94,softness2:75,secondEnabled:true,contrast:1.2,lift:1,background:12,profile:'band',invert:false,reverse:false,advanced:true,
 planes:[{enabled:true,yaw:37,pitch:-15,slide:4,pivot:{x:.4,y:.6,depth:25}},{enabled:true,yaw:-45,pitch:15,slide:5,pivot:{x:.4,y:.8,depth:70}}]};
let cases=0;
for(const profile of ['band','mask','ramp'])for(const secondEnabled of [true,false])for(const invert of [true,false])for(const reverse of [true,false])for(const contrast of [.3,1,2.5]) {
 const p={...params,profile,secondEnabled,invert,reverse,contrast,lift:contrast};
 const expected=js.applyFocus(data,depth,p,'gray',w,h);
 const actual=wasm.applyFocus(data,depth,p,'gray',w,h);
 assert.deepEqual(actual,expected,JSON.stringify({profile,secondEnabled,invert,reverse,contrast}));
 const inplace=data.slice();assert.equal(wasm.applyFocus(inplace,depth,p,'gray',w,h,0,true),inplace);assert.deepEqual(inplace,expected);
 cases++;
}
// Strips use full-frame coordinates; this strip is large enough to use WASM.
const full=wasm.applyFocus(data,depth,params,'gray',w,h);
const start=31,rows=70;
assert.deepEqual(wasm.applyFocus(data.slice(start*w*4,(start+rows)*w*4),depth.slice(start*w,(start+rows)*w),params,'gray',w,h,start),full.slice(start*w*4,(start+rows)*w*4));
for(const mode of ['gray','hue','spectral']) {
 const p={...params,advanced:false};assert.deepEqual(wasm.applyFocus(data,depth,p,mode,w,h),js.applyFocus(data,depth,p,mode,w,h));
}
const zero={...params,planes:params.planes.map(p=>({...p,yaw:0,pitch:0}))};
assert.deepEqual(wasm.applyFocus(data,depth,zero,'gray',w,h),js.applyFocus(data,depth,zero,'gray',w,h));
assert.throws(()=>wasm.applyFocus(data,depth,params,'gray',w,h,1),/coordinates/);
// End-to-end worker protocol, including mixed maps and two detail layers.
for(const p of [js,wasm]) {
 p.process('prepare',{buffer:data.slice().buffer,width:w,height:h,encoding:'gray'});
 p.process('prepareDepth2',{buffer:texture.slice().buffer,encoding:'gray'});
 p.process('prepareDetail',{index:0,buffer:texture.slice().buffer});
 p.process('prepareDetail',{index:1,buffer:data.slice().buffer});
}
const payload={params,depthMix:{enabled:true,weight:47,reverse:true},details:[{enabled:true,opacity:63,blend:'multiply'},{enabled:true,opacity:35,blend:'overlay'}]};
assert.deepEqual(wasm.process('render',payload),js.process('render',payload));
console.log(`PASS: ${cases} spatial variants, byte parity, alpha, in-place, strip coordinates, flat/hue fallback, worker operations and failed WASM load`);
