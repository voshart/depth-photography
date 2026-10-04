// Optional integration test: requires ffmpeg + ffprobe with libx264/libx265.
// Encodes real test clips, remuxes their packets, then compares decoded pixels.
// This tests the container, not WebCodecs availability on a particular device.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { VideoMp4 } from '../mp4.js';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'depth-mp4-test-'));
function unhex(s){return new Uint8Array(Buffer.from(s.split('\n').filter(l=>l.includes(':')).map(l=>l.split(':')[1].split('  ')[0].replace(/\s/g,'')).join(''),'hex'));}
const run=(cmd,args)=>execFileSync(cmd,args,{maxBuffer:16*1024*1024});
try{
 for(const [name,codec,fps,args] of [['avc','avc',30,['-c:v','libx264','-bf','0']],['avc-b','avc',30,['-c:v','libx264','-bf','2']],['hevc','hevc',24,['-c:v','libx265','-x265-params','log-level=error:pools=1','-tag:v','hvc1']]]){
  const original=path.join(dir,name+'.mp4'),output=path.join(dir,name+'-remux.mp4');
  run('ffmpeg',['-v','error','-y','-f','lavfi','-i',`testsrc2=size=320x240:rate=${fps}:duration=1`,...args,'-pix_fmt','yuv420p',original]);
  const probe=JSON.parse(run('ffprobe',['-v','error','-show_streams','-show_packets','-show_data','-of','json',original]));
  const stream=probe.streams[0],packets=probe.packets,writer=new VideoMp4({width:stream.width,height:stream.height,fps,frames:packets.length,codec});
  packets.forEach((packet,i)=>{const data=unhex(packet.data);assert.equal(data.length,Number(packet.size));writer.add({timestamp:Math.round(Number(packet.pts_time)*1e6),type:packet.flags.includes('K')?'key':'delta',byteLength:data.length,copyTo:dst=>dst.set(data)},i?{}:{decoderConfig:{description:unhex(stream.extradata)}});});
  fs.writeFileSync(output,new Uint8Array(await writer.finish().arrayBuffer()));
  const check=JSON.parse(run('ffprobe',['-v','error','-count_frames','-show_streams','-of','json',output])).streams[0];
  assert.equal(check.width,stream.width);assert.equal(check.height,stream.height);assert.equal(check.duration,stream.duration);assert.equal(Number(check.nb_read_frames),packets.length);
  const hashes=file=>run('ffmpeg',['-v','error','-i',file,'-f','framemd5','-']).toString().split('\n').filter(l=>l&&!l.startsWith('#')).map(l=>l.split(',').at(-1).trim());
  assert.deepEqual(hashes(output),hashes(original));
  const bytes=fs.readFileSync(output);assert(bytes.indexOf('moov')<bytes.indexOf('mdat'));
  console.log(`PASS: ${name}, ${check.width}×${check.height}, ${check.nb_read_frames} frames, fast-start MP4, identical decoded pixels`);
 }
}finally{fs.rmSync(dir,{recursive:true,force:true});}
