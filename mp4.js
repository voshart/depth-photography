/* A deliberately narrow ISO BMFF writer for one constant-frame-rate AVC/HEVC
 * video track. WebCodecs supplies codec configuration and length-prefixed NALs.
 * No audio, metadata copying, parsing of untrusted files, or codec implementation.
 * Layout: ftyp, moov (fast start), mdat. Supports reordered presentation times
 * and mid-stream WebCodecs decoderConfig changes by creating a new MP4 sample
 * description/chunk instead of rejecting the export.
 */
const text = value => Uint8Array.from(value, c => c.charCodeAt(0));
const zeros = n => new Uint8Array(n);
function numbers(size, values) {
  const bytes = new Uint8Array(size * values.length), v = new DataView(bytes.buffer);
  values.forEach((n, i) => size === 2 ? v.setUint16(i * size, n) : v.setUint32(i * size, n));
  return bytes;
}
const u16 = (...v) => numbers(2, v), u32 = (...v) => numbers(4, v);
const join = parts => { const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0)); let at = 0; for (const p of parts) { out.set(p, at); at += p.byteLength; } return out; };
const box = (name, ...parts) => join([u32(8 + parts.reduce((n, p) => n + p.byteLength, 0)), text(name), ...parts]);
const full = (name, version, flags, ...parts) => box(name, Uint8Array.of(version, flags >>> 16 & 255, flags >>> 8 & 255, flags & 255), ...parts);
const matrix = () => u32(0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000);
const sameBytes = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const copy = data => data instanceof ArrayBuffer ? new Uint8Array(data.slice(0)) : new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));

export class VideoMp4 {
  constructor({ width, height, fps, frames, codec, maxBytes = 128 * 1024 * 1024 }) {
    if (![24,30,60].includes(fps) || !Number.isInteger(frames) || frames < 2 || frames > 1800 || !Number.isInteger(width) || !Number.isInteger(height) || width < 2 || height < 2 || width > 8192 || height > 8192 || !['avc','hevc'].includes(codec)) throw new Error('Invalid MP4 track configuration.');
    Object.assign(this, { width, height, fps, expectedFrames: frames, codec, maxBytes, bytes: 0, samples: [], descriptions: [], currentDescription: 0 });
  }
  descriptionIndex(bytes) {
    const match = this.descriptions.findIndex(d => sameBytes(d, bytes));
    if (match >= 0) return match + 1;
    if (this.descriptions.length >= 32) throw new Error('The hardware encoder changed configuration too many times. Try a smaller output size or another browser.');
    this.descriptions.push(bytes);
    return this.descriptions.length;
  }
  add(chunk, metadata = {}) {
    if (this.samples.length >= this.expectedFrames) throw new Error('The encoder produced too many frames.');
    const d = metadata.decoderConfig;
    if (d?.description) {
      const bytes = copy(d.description);
      if (!bytes.length || bytes[0] !== 1) throw new Error('The encoder did not supply a supported MP4 codec configuration.');
      this.currentDescription = this.descriptionIndex(bytes);
    }
    if (!this.currentDescription) throw new Error('The encoder did not provide codec configuration before the first video frame.');
    if (this.bytes + chunk.byteLength > this.maxBytes) throw new Error('The encoded clip exceeded 128 MB. Choose a shorter loop or lower quality.');
    const data = new Uint8Array(chunk.byteLength); chunk.copyTo(data);
    const frame = Math.round(chunk.timestamp * this.fps / 1e6);
    if (!Number.isFinite(chunk.timestamp) || Math.abs(chunk.timestamp - frame * 1e6 / this.fps) > 2 || frame < 0 || frame >= this.expectedFrames) throw new Error('The encoder returned an unexpected frame timestamp.');
    this.samples.push({ data, frame, key: chunk.type === 'key', description: this.currentDescription }); this.bytes += data.byteLength;
  }
  sampleEntry(description) {
    return box(this.codec === 'avc' ? 'avc1' : 'hvc1',zeros(6),u16(1),zeros(16),u16(this.width,this.height),u32(0x480000,0x480000,0),u16(1),zeros(32),u16(24,0xffff),box(this.codec === 'avc' ? 'avcC' : 'hvcC',description),box('pasp',u32(1,1)));
  }
  chunks(offset) {
    const out=[]; let start=0, bytesBefore=0;
    while (start < this.samples.length) {
      const description=this.samples[start].description; let end=start+1, size=this.samples[start].data.byteLength;
      while (end < this.samples.length && this.samples[end].description === description) { size += this.samples[end].data.byteLength; end++; }
      out.push({ firstSample:start, count:end-start, description, offset:offset+bytesBefore });
      bytesBefore += size; start=end;
    }
    return out;
  }
  movie(offset) {
    const samples = this.samples, duration = samples.length * (90000 / this.fps), step = 90000 / this.fps, chunks=this.chunks(offset);
    const mvhd = full('mvhd',0,0,u32(0,0,90000,duration,0x10000),u16(0x100,0),zeros(8),matrix(),zeros(24),u32(2));
    const tkhd = full('tkhd',0,7,u32(0,0,1,0,duration),zeros(8),u16(0,0,0,0),matrix(),u32(this.width * 65536,this.height * 65536));
    const mdhd = full('mdhd',0,0,u32(0,0,90000,duration),u16(0x55c4,0));
    const hdlr = full('hdlr',0,0,u32(0),text('vide'),zeros(12),text('Depth Photography\0'));
    const vmhd = full('vmhd',0,1,u16(0,0,0,0));
    const dinf = box('dinf',full('dref',0,0,u32(1),full('url ',0,1)));
    const entries=this.descriptions.map(description=>this.sampleEntry(description));
    const stsd = full('stsd',0,0,u32(entries.length),...entries), stts = full('stts',0,0,u32(1,samples.length,step));
    const reordered = samples.some((s, i) => s.frame !== i);
    const ctts = reordered ? full('ctts',1,0,u32(samples.length),...samples.map((s,i) => u32(1,(s.frame-i)*step))) : zeros(0);
    const stsc = full('stsc',0,0,u32(chunks.length),...chunks.map((c,i)=>u32(i+1,c.count,c.description)));
    const stsz = full('stsz',0,0,u32(0,samples.length),...samples.map(s => u32(s.data.byteLength)));
    const stco = full('stco',0,0,u32(chunks.length,...chunks.map(c=>c.offset)));
    const keys = samples.flatMap((s,i) => s.key ? [i+1] : []), stss = full('stss',0,0,u32(keys.length,...keys));
    return box('moov',mvhd,box('trak',tkhd,box('mdia',mdhd,hdlr,box('minf',vmhd,dinf,box('stbl',stsd,stts,ctts,stsc,stsz,stco,stss)))));
  }
  finish() {
    if (!this.descriptions.length || this.samples.length !== this.expectedFrames || !this.samples[0]?.key || new Set(this.samples.map(s=>s.frame)).size !== this.expectedFrames) throw new Error('The encoder did not return a complete, decodable clip. No partial video was saved.');
    const ftyp = box('ftyp',text('isom'),u32(0x200),text('isomiso2mp41'),text(this.codec === 'avc' ? 'avc1' : 'hvc1'));
    const moov = this.movie(ftyp.byteLength + this.movie(0).byteLength + 8);
    const blob = new Blob([ftyp,moov,u32(this.bytes+8),text('mdat'),...this.samples.map(s=>s.data)],{type:'video/mp4'});
    this.samples = []; this.descriptions = []; this.currentDescription = 0;
    return blob;
  }
}
