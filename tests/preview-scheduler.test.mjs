import assert from 'node:assert/strict';
import { createPreviewScheduler } from '../preview-scheduler.js';
let state=0,generation=0,isReady=true,syncs=0,active=0,maxActive=0;
const frames=[],jobs=[],painted=[],errors=[];
const scheduler=createPreviewScheduler({frame:f=>frames.push(f),sync:()=>syncs++,ready:()=>isReady,epoch:()=>generation,
 render:()=>{active++;maxActive=Math.max(maxActive,active);const position=state;return new Promise((resolve,reject)=>jobs.push({position,resolve:value=>{active--;resolve(value);},reject:error=>{active--;reject(error);}}));},
 paint:value=>painted.push(value),error:e=>errors.push(e.message)});
function request(value){state=value;scheduler.request();}
function tick(){assert(frames.length);return frames.shift()();}
for(let i=0;i<100;i++)request(i);
assert.equal(frames.length,1);const first=tick();assert.equal(syncs,1);assert.equal(jobs[0].position,99);
for(let i=100;i<200;i++)request(i);
await tick();assert.equal(jobs.length,1);assert.equal(syncs,2);
jobs[0].resolve(99);await first;
assert.deepEqual(painted,[99]); // Movement must not starve the preview.
assert.equal(frames.length,1);const latest=tick();assert.equal(jobs[1].position,199);
jobs[1].resolve(199);await latest;assert.deepEqual(painted,[99,199]);assert.equal(maxActive,1);assert.equal(frames.length,0);
request(200);const stale=tick();generation++;isReady=false;jobs[2].resolve(200);await stale;assert.deepEqual(painted,[99,199]);
isReady=true;request(201);const restored=tick();jobs[3].resolve(201);await restored;assert.equal(painted.at(-1),201);
request(202);const failed=tick();jobs[4].reject(new Error('worker failed'));await failed;assert.deepEqual(errors,['worker failed']);
request(203);const recovery=tick();jobs[5].resolve(203);await recovery;assert.equal(painted.at(-1),203);
console.log('PASS: burst coalescing, serial renders, progress during continuous input, latest final position, changed-image invalidation and error recovery');
