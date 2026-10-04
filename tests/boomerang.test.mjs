import assert from 'node:assert/strict';
import { bounceAt, videoPlan, frameParams, sweepEndpoints, codecCandidates, supportedConfig } from '../boomerang-core.js';
import { createProcessor } from '../processor.js';
import { VideoMp4 } from '../mp4.js';
const params = { center: 25, center2: 70, width: 18, width2: 23, softness: 94, softness2: 75, secondEnabled: true, contrast: 1.2, lift: 1, background: 0, profile: 'band', invert: false, reverse: false, advanced: false, planes: [{enabled:true,yaw:0,pitch:0,slide:0,pivot:{x:.5,y:.5,depth:25}},{enabled:true,yaw:45,pitch:15,slide:5,pivot:{x:.4,y:.8,depth:70}}] };
const snapshot = {width:1157,height:1536,mode:'gray',params};
const settings = {focus:1,from:0,to:100,fps:30,duration:4,motion:'ease',quality:'high',resolution:'native',codec:'avc'};
for(const motion of ['ease','linear']) {
 assert.equal(bounceAt(0,10,90,motion),10);assert.equal(bounceAt(.5,10,90,motion),90);assert.equal(bounceAt(1,10,90,motion),10);
 for(let k=1;k<60;k++)assert(Math.abs(bounceAt(k/120,0,100,motion)-bounceAt((120-k)/120,0,100,motion))<1e-10);
}
let plan=videoPlan(snapshot,settings);
assert.equal(plan.frames,120);assert.equal(plan.duration,4);assert.equal(plan.width,1157);assert.equal(plan.codedWidth,1158);assert.equal(plan.codedHeight,1536);assert(plan.native);assert(plan.padded);
assert.equal(videoPlan(snapshot,{...settings,resolution:'960'}).height,960);
assert.equal(videoPlan(snapshot,{...settings,duration:3.1}).frames,94);
const before=JSON.stringify(snapshot), mid=frameParams(snapshot,settings,.5);
assert.equal(mid.center,100);assert.equal(mid.center2,70);assert.equal(JSON.stringify(snapshot),before);
const spatial=structuredClone(snapshot);spatial.params.advanced=true;
assert.deepEqual(sweepEndpoints(spatial,1),[-25,75]);
const rotated=frameParams(spatial,{...settings,focus:2,from:-30,to:40},.5);
assert.equal(rotated.planes[1].slide,40);assert.equal(rotated.planes[1].yaw,45);assert.equal(rotated.planes[1].pitch,15);assert.equal(rotated.planes[0].slide,0);
assert.throws(()=>videoPlan(snapshot,{...settings,to:0}),/different/);
assert.throws(()=>videoPlan(snapshot,{...settings,duration:31}),/30 seconds/);
assert.throws(()=>videoPlan(snapshot,{...settings,fps:12}),/frame/);
assert.throws(()=>videoPlan({...snapshot,width:10000,height:10000},settings),/16 megapixels/);
assert.throws(()=>videoPlan({...snapshot,params:{...params,secondEnabled:false}},{...settings,focus:2}),/Focus B/);
assert(codecCandidates(plan).every(s=>/^avc1\.[0-9a-f]{6}$/.test(s)));
assert(codecCandidates({...plan,codec:'hevc'}).every(s=>/^hvc1\./.test(s)));
assert.equal(await supportedConfig(plan),null); // Node has no native VideoEncoder.
const p=createProcessor(), rgba=new Uint8ClampedArray(800),tex=new Uint8ClampedArray(800),compact=new Uint8Array(400);
for(let i=0;i<200;i++){rgba.set([i,i,i,i%3?255:0],i*4);tex.set([255-i,255-i,255-i,i%4?125:255],i*4);compact.set([tex[i*4],tex[i*4+3]],i*2);}
for(const blend of ['multiply','overlay'])for(const opacity of [0,15,63,100]){
 const settings={enabled:true,opacity,blend};assert.deepEqual(p.blendDetail(rgba.slice(),tex,settings),p.blendDetail(rgba.slice(),compact,settings,true));
}
const writer=new VideoMp4({width:320,height:240,fps:30,frames:30,codec:'avc'});
assert.throws(()=>writer.finish(),/complete/);
assert.throws(()=>new VideoMp4({width:320,height:240,fps:30,frames:1801,codec:'avc'}),/configuration/);
const changing=new VideoMp4({width:320,height:240,fps:30,frames:4,codec:'avc'});
const descA=Uint8Array.of(1,100,0,31,255,225,0,1,103,1,1,0,1,104),descB=Uint8Array.of(1,100,0,31,255,225,0,1,103,2,1,0,1,104);
const fake=(frame,key=false)=>({timestamp:Math.round(frame*1e6/30),type:key?'key':'delta',byteLength:4,copyTo:dst=>dst.set([0,0,0,frame])});
changing.add(fake(0,true),{decoderConfig:{description:descA}});
changing.add(fake(1));changing.add(fake(2,true),{decoderConfig:{description:descB}});changing.add(fake(3));
const changedBlob=changing.finish(),changedBytes=new Uint8Array(await changedBlob.arrayBuffer()),changedText=Buffer.from(changedBytes).toString('latin1');
assert.equal((changedText.match(/avcC/g)||[]).length,2);
const stco=changedText.indexOf('stco');assert(stco>0);assert.equal(new DataView(changedBytes.buffer,changedBytes.byteOffset).getUint32(stco+8),2);
console.log('PASS: timing, symmetric loop, even padding, limits, immutable snapshots, plane translation, compact details, MP4 config changes and validation');
