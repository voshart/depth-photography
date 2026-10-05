'use strict';

export function createProcessor(kernels = null) {
  const SIZE = 16384, LAST = SIZE - 2, INVALID = SIZE - 1;
  const spectral = [[158,1,66],[213,62,79],[244,109,67],[253,174,97],[254,224,139],[255,255,191],[230,245,152],[171,221,164],[102,194,165],[50,136,189],[94,79,162]];
  const segments = spectral.slice(0,-1).map((p,i) => {const q=spectral[i+1],v=q.map((x,j)=>x-p[j]);return {p,v,d:v.reduce((s,x)=>s+x*x,0)};});
  let cube = null, pixels = null, values = null, detailPixels = [null,null], resolved = 'spectral';
  let secondPixels=null, secondValues=null, secondMode='gray', mixCache=null, mixCacheKey='';
  let frameWidth=0,frameHeight=0,toneCache=null,toneCacheKey='';
  const clamp=(x,a=0,b=1)=>Math.min(b,Math.max(a,x));
  const smooth=x=>x*x*(3-2*x);
  function hue(r,g,b) {
    const hi=Math.max(r,g,b),lo=Math.min(r,g,b),d=hi-lo;
    if(hi===0 || d/hi<0.035) return -1;
    let h=hi===r?(g-b)/d:hi===g?(b-r)/d+2:(r-g)/d+4;
    return ((h/6)%1+1)%1;
  }
  function nearest(r,g,b,start=0,end=9) {
    let best=Infinity,bestT=0,bestI=0;
    for(let i=start;i<=end;i++) {
      const s=segments[i],rr=r-s.p[0],gg=g-s.p[1],bb=b-s.p[2];
      const t=clamp((rr*s.v[0]+gg*s.v[1]+bb*s.v[2])/s.d);
      const dr=rr-t*s.v[0],dg=gg-t*s.v[1],db=bb-t*s.v[2],e=dr*dr+dg*dg+db*db;
      if(e<best){best=e;bestT=(i+t)/10;bestI=i;}
    }
    return {t:bestT,error:best,index:bestI};
  }
  // A 32^3 accelerator locates the palette segment, not the depth value itself.
  // Projecting each actual RGB pixel onto that segment avoids LUT colour banding.
  function ensureCube() {
    if(cube)return;
    cube=new Uint8Array(32768);
    for(let r=0;r<32;r++)for(let g=0;g<32;g++)for(let b=0;b<32;b++)cube[(r<<10)|(g<<5)|b]=nearest(r*8+3.5,g*8+3.5,b*8+3.5).index;
  }
  function spectralValue(r,g,b) {
    const i=cube[((r>>3)<<10)|((g>>3)<<5)|(b>>3)];
    // Adjacent segments are checked too, for accurate interpolation at the knots.
    return nearest(r,g,b,Math.max(0,i-1),Math.min(9,i+1)).t;
  }
  function detect(data) {
    let total=0,gray=0,error=0;
    const step=Math.max(1,Math.floor(data.length/4/4000))*4;
    for(let i=0;i<data.length;i+=step){if(data[i+3]<32)continue;const r=data[i],g=data[i+1],b=data[i+2];total++;if(Math.max(r,g,b)-Math.min(r,g,b)<8)gray++;error+=nearest(r,g,b).error;}
    if(!total)return {mode:'gray',error:0};
    const rms=Math.sqrt(error/total/3);
    return {mode:gray/total>.96?'gray':rms<13?'spectral':'hue',error:rms};
  }
  function decode(data,mode) {
    if(mode==='spectral')ensureCube();
    const out=new Uint16Array(data.length/4);
    for(let p=0,i=0;i<data.length;i+=4,p++) {
      const r=data[i],g=data[i+1],b=data[i+2];
      const t=mode==='spectral'?spectralValue(r,g,b):mode==='hue'?hue(r,g,b):(0.2126*r+0.7152*g+0.0722*b)/255;
      out[p]=(t<0 || data[i+3]===0)?INVALID:Math.round(clamp(t)*LAST);
    }
    return out;
  }
  function windowValue(d,p,second=false) {
    const h=(second?p.width2:p.width)/200;
    const softness=second?p.softness2:p.softness;
    const a=Math.abs(d);
    if(a>h)return 0;
    if(p.profile==='mask')return 1;
    const feather=h*softness/100,inner=h-feather;
    let value=feather<1e-9?1:1-smooth(clamp((a-inner)/feather));
    if(p.profile==='ramp'){
      let ramp=clamp(.5+d/(2*h));
      if(p.reverse)ramp=1-ramp;
      value*=ramp;
    }
    return value;
  }
  function band(t,p,mode,second=false) {
    let d=t-(second?p.center2:p.center)/100;
    if(mode==='hue')d=((d+1.5)%1)-.5;
    return windowValue(d,p,second);
  }
  function shapeTone(value,p) {
    if(p.profile!=='mask' && value>0 && value<1){
      const u=Math.pow(value,p.contrast),v=Math.pow(1-value,p.contrast);
      value=Math.pow(u/(u+v),1/p.lift);
    }
    value=p.background/100+(1-p.background/100)*value;
    return p.invert?1-value:value;
  }
  function tone(t,p,mode) {
    let value=band(t,p,mode);
    if(p.secondEnabled)value=Math.max(value,band(t,p,mode,true));
    return shapeTone(value,p);
  }
  // The plane is represented by a unit normal, a pivot and a normal offset.
  // World X points right, Y up, and Z toward depth value 1. Image aspect is
  // respected: the longest image side = 1 and decoded depth range = 1.
  function planeNormal(plane) {
    const yaw=(plane?.yaw||0)*Math.PI/180,pitch=(plane?.pitch||0)*Math.PI/180;
    const clean=x=>Math.abs(x)<1e-14?0:x;
    return [clean(Math.sin(yaw)*Math.cos(pitch)),clean(-Math.sin(pitch)),clean(Math.cos(yaw)*Math.cos(pitch))];
  }
  function focusPlane(p,index,mode,width,height) {
    const center=(index===1?p.center2:p.center)/100,pl=p.planes?.[index];
    const aspect=p.frameAspect||width/height||1,sx=aspect>=1?1:aspect,sy=aspect>=1?1/aspect:1;
    const on=p.advanced&&mode!=='hue'&&pl?.enabled;
    const normal=on?planeNormal(pl):[0,0,1];
    const pivot=on?[(pl.pivot.x-.5)*sx,(.5-pl.pivot.y)*sy,pl.pivot.depth/100-.5]:[0,0,center-.5];
    const slide=on?pl.slide/100:0;
    // n.dot(point) - constant = signed distance to the sheet.
    const constant=normal[0]*pivot[0]+normal[1]*pivot[1]+normal[2]*pivot[2]+slide;
    return {normal,pivot,slide,constant,sx,sy};
  }
  function planeDistance(point,plane){return plane.normal[0]*point[0]+plane.normal[1]*point[1]+plane.normal[2]*point[2]-plane.constant;}
  function applyFocus(data,depth,p,mode,width,height,offsetY=0,inPlace=false,retainInputs=false) {
    const spatial=p.advanced&&mode!=='hue'&&(p.planes?.[0]?.enabled||(p.secondEnabled&&p.planes?.[1]?.enabled));
    if(!spatial)return applyFlat(data,depth,p,mode,inPlace,retainInputs);
    if(!Number.isInteger(width)||!Number.isInteger(height)||width<1||height<1||data.length%(4*width)!==0||!Number.isInteger(offsetY)||offsetY<0||offsetY+data.length/(4*width)>height)
      throw new Error('Invalid frame coordinates for 3D plane rendering.');
    const a=focusPlane(p,0,mode,width,height),b=focusPlane(p,1,mode,width,height);
    // At zero rotation this is exactly the original flat-band calculation.
    if(a.normal[0]===0&&a.normal[1]===0&&a.normal[2]===1&&(!p.secondEnabled||b.normal[0]===0&&b.normal[1]===0&&b.normal[2]===1))
      return applyFlat(data,depth,{...p,center:(a.constant+.5)*100,center2:(b.constant+.5)*100},mode,inPlace,retainInputs);
    // Plane position/rotation changes do not change the tone curve. Reuse it
    // while scrubbing or exporting an animation instead of 65,536 powers/frame.
    const key=[p.profile,p.contrast,p.lift,p.background,p.invert].join('|');
    if(!toneCache || toneCacheKey!==key){
      toneCache=new Uint8Array(65536);toneCacheKey=key;
      for(let i=0;i<65536;i++)toneCache[i]=Math.round(clamp(shapeTone(i/65535,p))*255);
    }
    const toneTable=toneCache;
    if(kernels && depth.length===data.length/4 && data.length>=65536)
      return kernels.spatial(data,depth,toneTable,p,a,b,width,height,offsetY,inPlace);
    const out=inPlace?data:new Uint8ClampedArray(data.length);
    const noDepth=Math.round(clamp(shapeTone(0,p))*255),rows=data.length/(4*width),lastInv=1/LAST;
    // Full-frame coordinates make strip exports agree with a one-pass render.
    for(let y=0,pos=0;y<rows;y++){
      const worldY=(.5-(y+offsetY+.5)/height)*a.sy;
      const rowA=a.normal[1]*worldY-a.constant-.5*a.normal[2];
      const rowB=b.normal[1]*worldY-b.constant-.5*b.normal[2];
      for(let x=0;x<width;x++,pos++){
        const i=pos*4,alpha=data[i+3];let value=noDepth;
        if(depth[pos]!==INVALID){
          const worldX=((x+.5)/width-.5)*a.sx,t=depth[pos]*lastInv;
          let weight=windowValue(a.normal[0]*worldX+a.normal[2]*t+rowA,p);
          if(p.secondEnabled)weight=Math.max(weight,windowValue(b.normal[0]*worldX+b.normal[2]*t+rowB,p,true));
          value=weight>0&&weight<1&&(weight<.001||weight>.999)?Math.round(clamp(shapeTone(weight,p))*255):toneTable[Math.round(clamp(weight)*65535)];
        }
        out[i]=out[i+1]=out[i+2]=value;out[i+3]=alpha;
      }
    }
    return out;
  }

  function applyFlat(data,depth,p,mode,inPlace,retainInputs) {
    if(kernels && depth.length===data.length/4 && data.length>=65536)
      return kernels.flat(data,depth,p,mode,inPlace,retainInputs);
    return apply(data,depth,lookup(p,mode),inPlace);
  }
  function lookup(params,mode) {
    const table=new Uint8Array(SIZE);
    for(let i=0;i<=LAST;i++)table[i]=Math.round(clamp(tone(i/LAST,params,mode))*255);
    table[INVALID]=Math.round((params.invert?1-params.background/100:params.background/100)*255);
    return table;
  }
  function apply(data,depth,table,inPlace=false) {
    const out=inPlace?data:new Uint8ClampedArray(data.length);
    for(let p=0,i=0;i<data.length;i+=4,p++){const v=table[depth[p]];out[i]=v;out[i+1]=v;out[i+2]=v;out[i+3]=data[i+3];}
    return out;
  }
  function grayscale(data) {
    for(let i=0;i<data.length;i+=4) {
      const gray=Math.round(.2126*data[i]+.7152*data[i+1]+.0722*data[i+2]);
      data[i]=data[i+1]=data[i+2]=gray;
    }
    return data;
  }
  function blendDetail(base,texture,settings,compact=false) {
    if(!texture||!settings||!settings.enabled||!(settings.opacity>0))return base;
    if(texture.length!==(compact?base.length/2:base.length))throw new Error('The detail layer must be aligned to the depth image.');
    const opacity=clamp(settings.opacity/100,0,1),overlay=settings.blend==='overlay';
    // Work in the same display-referred, 8-bit space as the focus image.
    // Interpolate the blend result with the base. Preserve depth alpha exactly.
    // A transparent detail pixel or an uncovered Fit margin has no effect.
    for(let i=0;i<base.length;i+=4) {
      const j=compact?i/2:i,alpha=texture[j+(compact?1:3)];
      if(!base[i+3]||!alpha)continue;
      const b=base[i]/255,d=texture[j]/255,a=opacity*alpha/255;
      const mixed=overlay?(b<=.5?2*b*d:1-2*(1-b)*(1-d)):b*d;
      const value=Math.round(clamp(b+a*(mixed-b))*255);
      base[i]=base[i+1]=base[i+2]=value;
    }
    return base;
  }
  function colour(t,mode) {
    t=clamp(t);
    if(mode==='gray')return [t*255,t*255,t*255];
    if(mode==='spectral'){const n=Math.min(9,Math.floor(t*10)),u=t*10-n;return spectral[n].map((x,i)=>x+(spectral[n+1][i]-x)*u);}
    const h=(t%1)*6,c=255,x=c*(1-Math.abs(h%2-1));
    return h<1?[c,x,0]:h<2?[x,c,0]:h<3?[0,c,x]:h<4?[0,x,c]:h<5?[x,0,c]:[c,0,x];
  }
  function blendDepth(base,other,rgba,settings) {
    if(!other||!rgba||!settings?.enabled||!(settings.weight>0))return base;
    if(other.length!==base.length||rgba.length!==base.length*4)throw new Error('Depth maps must be aligned before averaging.');
    const out=new Uint16Array(base.length),weight=clamp(settings.weight/100);
    for(let p=0;p<base.length;p++) {
      const a=base[p],b=other[p],coverage=rgba[p*4+3]/255;
      // Preserve the reference mask. Invalid/missing Map 2 never pulls depth
      // toward black. Transparency is coverage, not a numerical depth value.
      if(a===INVALID||b===INVALID||coverage===0){out[p]=a;continue;}
      const second=settings.reverse?LAST-b:b;
      out[p]=Math.round(a+(second-a)*weight*coverage);
    }
    return out;
  }
  function mixedValues(settings) {
    if(!secondValues||resolved==='hue'||secondMode==='hue'||!settings?.enabled||!(settings.weight>0))return values;
    const key=[settings.weight,settings.reverse].join('|');
    if(!mixCache||mixCacheKey!==key){mixCache=blendDepth(values,secondValues,secondPixels,settings);mixCacheKey=key;}
    return mixCache;
  }
  function process(type,payload) {
    if(type==='prepare') {
      pixels=new Uint8ClampedArray(payload.buffer);detailPixels=[null,null];
      frameWidth=payload.width;frameHeight=payload.height;
      secondPixels=secondValues=mixCache=null;mixCacheKey='';
      const detection=detect(pixels);resolved=payload.encoding==='auto'?detection.mode:payload.encoding;
      values=decode(pixels,resolved);
      const hist=new Float64Array(256);
      for(let i=0;i<values.length;i++)if(values[i]!==INVALID)hist[Math.min(255,Math.floor(values[i]/LAST*255))]+=pixels[i*4+3]/255;
      return {mode:resolved,histogram:Array.from(hist),values:values.slice().buffer,error:detection.error};
    }
    if(type==='prepareDepth2') {
      mixCache=null;mixCacheKey='';
      if(!payload.buffer){secondPixels=secondValues=null;return {cleared:true};}
      const candidate=new Uint8ClampedArray(payload.buffer);
      if(!pixels||candidate.length!==pixels.length)throw new Error('Second depth map and preview sizes do not match.');
      const detection=detect(candidate),mode=payload.encoding==='auto'?detection.mode:payload.encoding;
      const decoded=decode(candidate,mode);
      secondPixels=candidate;secondValues=decoded;secondMode=mode;
      return {mode,error:detection.error,buffer:secondPixels.slice().buffer,values:secondValues.slice().buffer};
    }
    if(type==='prepareDetail') {
      const index=payload.index;
      if(index!==0&&index!==1)throw new Error('Invalid detail layer index.');
      if(!payload.buffer){detailPixels[index]=null;return {cleared:true};}
      const candidate=new Uint8ClampedArray(payload.buffer);
      if(!pixels||candidate.length!==pixels.length)throw new Error('Detail and preview sizes do not match.');
      detailPixels[index]=grayscale(candidate);
      return {buffer:detailPixels[index].slice().buffer};
    }
    if(type==='render') {
      if(!pixels || !values)throw new Error('Load an image first.');
      const output=applyFocus(pixels,mixedValues(payload.depthMix),payload.params,resolved,frameWidth,frameHeight,0,false,true);
      for(let i=0;i<2;i++)blendDetail(output,detailPixels[i],payload.details?.[i]);
      return {buffer:output.buffer};
    }
    if(type==='exportStrip') {
      const data=new Uint8ClampedArray(payload.buffer);
      let depth=decode(data,payload.mode);
      if(payload.depth2Buffer&&payload.mode!=='hue'&&payload.depth2Mode!=='hue') {
        const other=new Uint8ClampedArray(payload.depth2Buffer);
        depth=blendDepth(depth,decode(other,payload.depth2Mode),other,payload.depthMix);
      }
      const output=applyFocus(data,depth,payload.params,payload.mode,payload.width,payload.height,payload.offsetY||0,true);
      for(let i=0;i<2;i++) {
        const buffer=payload.detailBuffers?.[i];
        if(buffer)blendDetail(output,grayscale(new Uint8ClampedArray(buffer)),payload.details?.[i]);
      }
      return {buffer:output.buffer};
    }
    throw new Error('Unknown processing operation.');
  }
  return {backend:kernels?'rust-wasm':'javascript',process,decode,tone,colour,grayscale,blendDetail,blendDepth,planeNormal,focusPlane,planeDistance,windowValue,shapeTone,applyFocus,LAST,INVALID};
}
