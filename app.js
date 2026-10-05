import { createPreviewScheduler } from './preview-scheduler.js?v=20261005-wasm3';
import { createProcessor } from './processor.js?v=20261005-wasm3';
import { createAcceleratedProcessor } from './processor-wasm.js?v=20261005-wasm3';

'use strict';
/* DEPTH / FOCUS
 * Single-file offline editor, no dependencies. All source image data stays local.
 * The built-in demonstration is the depth map supplied with the request.
 * Spectral palette colours: ColorBrewer (C. Brewer, M. Harrower, Penn State).
 * Algorithm: decode / average depth -> two flat or signed-distance plane windows -> shared tone -> details.
 * v8 rotates unit plane normals around picked pivots; translation is a separate normal offset.
 * v9 adds cursor-anchored zoom, touch pinch, and panning on a common clipped image
 * window. Zoom uses CSS pixels per source pixel, capped at 4x; no new full-size
 * processing canvas is allocated. View transforms never affect output or recipes.
 * Wheel and pointer event references: MDN Element/wheel_event and
 * Web/API/Pointer_events/Pinch_zoom_gestures. No libraries or network requests.
 * Geometry is orthographic normalized image/depth space, not metric reconstruction.
 * The 3D inspector is an offline Canvas2D projection of the same model. No external libraries.
 * v5 adds two independent grayscale detail layers, composited in order 1 -> 2.
 * Both opacity sliders cover 0–100%; the base sliders share a compact mobile deck; rotation controls appear only in Advanced.
 * One visible detail canvas is reused; original-size export uses one texture strip canvas.
 * v1/v2 looks bypass both layers; v3/v4 map the old layer to slot 1 and bypass slot 2.
 * Detail blend equations: https://www.w3.org/TR/compositing-1/#blending
 * Detail alpha modulates opacity; depth alpha is preserved, not composited over.
 * Preview is bounded to 1500 px on its long side; export is processed in strips
 * at original resolution. Input alpha is preserved. No raw 16-bit depth support.
 */
const EXAMPLE = new URL('./assets/example-depth.jpg', import.meta.url).href;

const DETAIL_EXAMPLE = new URL('./assets/example-normal.jpg', import.meta.url).href;

// This factory is shared verbatim by the UI and the worker to keep the curve,
// preview, picking, and full-resolution export mathematically identical.


const $=id=>document.getElementById(id);
const setAttr=(node,name,value)=>{value=String(value);if(node.getAttribute(name)!==value)node.setAttribute(name,value);};
const local=createProcessor();
let fallbackProcessor=null;
// Module workers keep rendering off the UI thread. If workers are disabled,
// lazily initialize the same accelerated processor on the main thread.
function createEngine() {
  let worker=null,sequence=0,pending=new Map();
  try {
    worker=new Worker(new URL('./processor.worker.js?v=20261005-wasm3', import.meta.url),{type:'module'});
    worker.onmessage=event=>{const {id,result,error}=event.data,item=pending.get(id);if(!item)return;pending.delete(id);error?item.reject(new Error(error)):item.resolve(result);};
    worker.onerror=event=>{event.preventDefault();for(const item of pending.values())item.reject(new Error('The image processor stopped. Try reloading the image or using a smaller file.'));pending.clear();worker.terminate();worker=null;};
  }catch(_){worker=null;}
  return {request(type,payload,transfer=[]){if(!worker)return (fallbackProcessor ||= createAcceleratedProcessor()).then(processor=>processor.process(type,payload));return new Promise((resolve,reject)=>{const id=++sequence;pending.set(id,{resolve,reject});worker.postMessage({id,type,payload},transfer);});}};
}
const engine=createEngine();
const defaults={center:21.5,width:18,softness:94,center2:65,width2:18,softness2:94,secondEnabled:false,contrast:1.2,lift:1,background:0,profile:'band',invert:false,reverse:false};
const makePlane=depth=>({enabled:true,yaw:0,pitch:0,slide:0,pivot:{x:.5,y:.5,depth}});
const makeParams=()=>({...defaults,advanced:false,planes:[makePlane(defaults.center),makePlane(defaults.center2)]});
const snapshotParams=()=>({...params,frameAspect:frameAspect(),planes:params.planes.map(p=>({...p,pivot:{...p.pivot}}))});
const detailDefaults={enabled:false,opacity:15,blend:'multiply',fit:'stretch'};
const depthMixDefaults={enabled:false,weight:50,encoding:'auto',fit:'stretch',reverse:false};
let secondaryDepth={settings:{...depthMixDefaults},image:null,width:0,height:0,name:'',mode:'gray',previewData:null,values:null};
let primaryDepthValues=null,primaryAlpha=null,depthMixDirty=true,depthPreview='mixed',depthPaintKey='',depthPalette=null,depthPaletteMode='';
const depthMixCompatible=()=>resolvedMode!=='hue'&&secondaryDepth.mode!=='hue';
const depthMixSnapshot=()=>({...secondaryDepth.settings,enabled:Boolean(secondaryDepth.image&&secondaryDepth.settings.enabled&&depthMixCompatible())});
const depthMixActive=()=>Boolean(depthMixSnapshot().enabled&&secondaryDepth.settings.weight>0);
// Settings, original image and preview pixels are independent for each slot.
const makeDetailLayer=()=>({settings:{...detailDefaults},image:null,width:0,height:0,name:'',previewData:null});
const detailLayers=[makeDetailLayer(),makeDetailLayer()];
let activeDetail=0;
const detailId=(stem,index=activeDetail)=>stem+(index===1?'2':'');
const detailSettingsSnapshot=()=>detailLayers.map(layer=>({...layer.settings}));
const detailIndexForView=(v=view)=>v==='detail'?0:v==='detail2'?1:-1;
const detailViewName=index=>index===1?'detail2':'detail';
let params=makeParams(),encoding='auto',resolvedMode='spectral',histogram=new Array(256).fill(0),depthValues=null;
let sourceImage=null,sourceWidth=0,sourceHeight=0,sourceName='depth-map-example.webp',previewWidth=0,previewHeight=0;
let view='focus',split=50,picking=false,holdSource=false,ready=false,working=false,exporting=false,version=0,previewEpoch=0;
let loadToken=0,toastTimer=0,ringTimer=0,activePreset='sculpted',activeFocus=1;
let pickedPoints={1:null,2:null};
// UI-only state: a source point at the centre of the visible image window.
const navigation={scale:1,fit:true,centerX:.5,centerY:.5,hand:false,space:false};
const MAX_IMAGE_ZOOM=4;
let imageLayout=null,navigationAnnounceTimer=0,pointerOverImage=false;
const sourceCanvas=$('sourceCanvas'),outputCanvas=$('outputCanvas'),sourceCtx=sourceCanvas.getContext('2d',{willReadFrequently:true}),outputCtx=outputCanvas.getContext('2d');
if(!sourceCtx||!outputCtx){$('busyText').textContent='This browser does not support Canvas 2D. Please open this file in a modern browser.';throw new Error('Canvas 2D unavailable.');}
const detailCanvas=$('detailCanvas'),detailCtx=detailCanvas.getContext('2d',{willReadFrequently:true});
if(!detailCtx)throw new Error('Canvas 2D unavailable for the detail layer.');
const depthCanvas=$('depthCanvas'),depthCtx=depthCanvas.getContext('2d');
if(!depthCtx)throw new Error('Canvas 2D unavailable for depth preview.');
const controls=['center','width','softness','center2','width2','softness2','contrast','lift','background'];
const firstVersionControls=['center','width','softness','contrast','lift','background'];
const focusKey=(key,focus=activeFocus)=>focus===2?key+'2':key;
const focusLetter=()=>activeFocus===2?'B':'A';
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const labels={spectral:'Spectral palette',hue:'Colour / hue',gray:'Grayscale values'};

// Appearance is separate from image data and never enters export processing.
const uiDarkQuery=window.matchMedia('(prefers-color-scheme: dark)');
function graphTheme(){
 const dark=uiDarkQuery.matches,css=getComputedStyle(document.documentElement);
 return {paper:dark?'#151515':'#ffffff',rule:dark?'#363636':'#dedede',hist:dark?'#454545':'#dedede',
  line:dark?'#eeeeee':'#333333',wash:dark?'rgba(255,255,255,.08)':'rgba(0,0,0,.05)',
  a:css.getPropertyValue('--focus-a').trim(),b:css.getPropertyValue('--focus-b').trim()};
}

function toast(message,error=false){clearTimeout(toastTimer);$('toast').textContent=message;$('toast').classList.toggle('error',error);$('toast').classList.add('show');toastTimer=setTimeout(()=>$('toast').classList.remove('show'),error?6500:3500);}
function setBusy(on,text='Processing…'){
 if(on)previewEpoch++;
 working=on;$('busyOverlay').hidden=!on;$('busyText').textContent=text;
 const exportLocked=on||!ready||exporting;
 $('exportBtn').disabled=exportLocked;
 if($('videoBtn'))$('videoBtn').disabled=exportLocked;
 for(const id of ['openBtn','exampleBtn','encoding','resetBtn','loadLookBtn'])$(id).disabled=on||exporting;
 syncDetailControls();syncDepthControls();syncPlaneControls();syncNavigation();
}
function touchSettings(){activePreset='';queueRender();}
function syncPreset(){document.querySelectorAll('[data-preset]').forEach(b=>b.classList.toggle('active',b.dataset.preset===activePreset));}
function syncControls(){
 for(const key of controls){
  const input=$(key),base=key.replace(/2$/,'');
  input.value=params[key];
  const pct=(params[key]-Number(input.min))/(Number(input.max)-Number(input.min))*100;
  input.style.setProperty('--fill',pct+'%');
  $(key+'Value').textContent=base==='contrast'||base==='lift'?params[key].toFixed(2)+'×':base==='center'||base==='width'?params[key].toFixed(1)+'%':Math.round(params[key])+'%';
 }
 $('profile').value=params.profile;
 $('invert').checked=params.invert;$('reverse').checked=params.reverse;
 $('reverseRow').hidden=params.profile!=='ramp';$('encoding').value=encoding;
 $('secondEnabled').checked=params.secondEnabled;
 const mask=params.profile==='mask';
 for(const id of ['softness','contrast','lift'])$(id).disabled=mask;
 for(const id of ['center2','width2','softness2'])$(id).disabled=!params.secondEnabled||(mask&&id==='softness2');
 for(const [n,letter] of [[1,'A'],[2,'B']]){
  $('focusCard'+letter).classList.toggle('active',activeFocus===n);
  $('focusSelect'+letter).setAttribute('aria-pressed',String(activeFocus===n));
  const rgb=local.colour(params[focusKey('center',n)]/100,resolvedMode).map(Math.round);
  const hex='#'+rgb.map(v=>v.toString(16).padStart(2,'0')).join('').toUpperCase();
  $('swatch'+letter).style.background=hex;
  if(activeFocus===n){$('focusSwatch').style.background=hex;$('focusHex').textContent=hex;}
 }
 setAttr($('focusCardB'),'data-enabled',params.secondEnabled);
 $('curveCanvas').setAttribute('aria-valuenow',params[focusKey('center')].toFixed(1));
 $('curveCanvas').setAttribute('aria-label','Focus '+focusLetter()+' position on the palette. Drag to move the active band, or drag its edges to change width.');
 $('paletteLeft').textContent=resolvedMode==='gray'?'BLACK':resolvedMode==='hue'?'0° · HUE':'PALETTE START';
 $('paletteRight').textContent=resolvedMode==='gray'?'WHITE':resolvedMode==='hue'?'360° · HUE':'PALETTE END';
 syncDepthControls();syncDetailControls();syncPlaneControls();syncPins();syncPreset();drawCurve();
}


let depthControlsKey='',detailControlsKey='';
function syncDepthControls(){
 const layer=secondaryDepth,s=layer.settings,has=Boolean(layer.image),locked=working||exporting,compatible=depthMixCompatible();
 const key=JSON.stringify([locked,ready,has,sourceName,sourceWidth,sourceHeight,layer.name,layer.width,layer.height,layer.mode,encoding,resolvedMode,depthPreview,s]);
 if(depthControlsKey===key)return;depthControlsKey=key;
 $('depth2Enabled').checked=has&&s.enabled;$('depth2Enabled').disabled=!has||locked;
 const slider=$('depthWeight');slider.value=s.weight;slider.style.setProperty('--fill',s.weight+'%');slider.disabled=!has||locked;
 $('depthWeightValue').textContent=s.weight+'%';
 for(const id of ['loadDepth1Btn','loadDepth1DialogBtn'])$(id).disabled=locked;
 for(const id of ['loadDepth2Btn','loadDepth2DialogBtn'])$(id).disabled=locked||!ready;
 $('depthOptionsBtn').disabled=locked;$('depthPreviewSelect').disabled=locked;
 $('depthPreviewSelect').value=depthPreview;$('depthPreviewSelect').querySelector('[value="two"]').disabled=!has;
 $('depthSection').dataset.active=String(depthMixActive());
 $('depth1Encoding').value=encoding;$('depth1Encoding').disabled=locked;
 $('depth2Encoding').value=s.encoding;$('depth2Encoding').disabled=locked;
 $('depth2Fit').value=s.fit;$('depth2Fit').disabled=locked;
 $('depth2Reverse').checked=s.reverse;$('depth2Reverse').disabled=locked;
 $('depthHalfBtn').disabled=!has||locked;$('removeDepth2Btn').disabled=!has||locked;
 const status=$('depthMixStatus');
 status.classList.toggle('warning',has&&s.enabled&&!compatible);
 status.textContent=!has?'Load Map 2 for a 50 / 50 depth average.':!s.enabled?'Map 2 paused · Map 1 only':!compatible?'Mix paused · choose Spectral or grayscale for both':s.weight===0?'Map 1 only · Map 2 weight is 0%':(100-s.weight)+'% Map 1 + '+s.weight+'% Map 2';
 status.title=has?layer.name+' · '+status.textContent:status.textContent;
 $('loadDepth1Btn').title='Map 1: '+sourceName;
 $('loadDepth2Btn').title=has?'Map 2: '+layer.name+' — click to replace':'Load a second matching depth map';
 const info=$('depthImageInfo');info.textContent='Map 1: '+(sourceWidth?sourceName+' · '+sourceWidth.toLocaleString()+' × '+sourceHeight.toLocaleString()+' px':'not loaded');
 info.append(document.createElement('br'),document.createTextNode('Map 2: '+(has?layer.name+' · '+layer.width.toLocaleString()+' × '+layer.height.toLocaleString()+' px':'not loaded')));
 const modeText='Map 1: '+labels[resolvedMode]+(has?' · Map 2: '+labels[layer.mode]:'');
 $('depthEncodingStatus').textContent=modeText+(has&&!compatible?' · Mixing is bypassed until both are read as compatible scalar depth.':' · Values are normalized palette positions / grayscale levels, not metres.');
 const mismatch=has&&sourceWidth>0&&Math.abs((layer.width/layer.height)/(sourceWidth/sourceHeight)-1)>.006;
 $('depthAlignmentNote').textContent=(mismatch?'Different aspect ratios. Check the Map 1 / Map 2 previews carefully. ':'')+'Map 1 sets the output size. '+({stretch:'Map 2 is stretched to the same frame.',cover:'Map 2 keeps its proportions and is centre-cropped.',contain:'Map 2 keeps its proportions; uncovered areas retain Map 1.'}[s.fit])+' No automatic object or edge registration.';
}
function updateDepthMix(){
 if(!depthMixDirty||!primaryDepthValues)return;
 depthValues=local.blendDepth(primaryDepthValues,secondaryDepth.values,secondaryDepth.previewData?.data,depthMixSnapshot());
 const hist=new Float64Array(256);
 for(let p=0;p<depthValues.length;p++)if(depthValues[p]!==local.INVALID)hist[Math.min(255,Math.floor(depthValues[p]/local.LAST*255))]+=(primaryAlpha?.[p]??255)/255;
 histogram=Array.from(hist);depthMixDirty=false;depthPaintKey='';
}
function currentDepthPreview(){return picking?'mixed':depthPreview;}
function usesDepthCanvas(){return currentDepthPreview()==='two'&&Boolean(secondaryDepth.previewData)||currentDepthPreview()==='mixed'&&depthMixActive();}
function paintDepthPreview(){
 const which=currentDepthPreview(),key=which+'|'+depthMixActive();
 if(depthPaintKey===key&&depthCanvas.width===previewWidth&&depthCanvas.height===previewHeight)return;
 depthCanvas.width=previewWidth;depthCanvas.height=previewHeight;
 if(which==='two'&&secondaryDepth.previewData)depthCtx.putImageData(secondaryDepth.previewData,0,0);
 else if(depthValues){
  if(!depthPalette||depthPaletteMode!==resolvedMode){
   depthPalette=new Uint8ClampedArray((local.LAST+1)*3);depthPaletteMode=resolvedMode;
   for(let i=0;i<=local.LAST;i++){const rgb=local.colour(i/local.LAST,resolvedMode);depthPalette.set(rgb,i*3);}
  }
  const data=new Uint8ClampedArray(previewWidth*previewHeight*4);
  for(let p=0,i=0;p<depthValues.length;p++,i+=4){
   const v=depthValues[p],j=v*3;
   if(v!==local.INVALID){data[i]=depthPalette[j];data[i+1]=depthPalette[j+1];data[i+2]=depthPalette[j+2];data[i+3]=primaryAlpha[p];}
  }
  depthCtx.putImageData(new ImageData(data,previewWidth,previewHeight),0,0);
 }
 depthPaintKey=key;
}
function openDepthOptions(){
 if(working||exporting)return;
 if($('settingsDialog').open)$('settingsDialog').close();
 syncDepthControls();if(!$('depthDialog').open)$('depthDialog').showModal();
}
async function prepareDepth2Preview(){
 const layer=secondaryDepth;
 if(!layer.image){layer.previewData=null;layer.values=null;await engine.request('prepareDepth2',{buffer:null});depthMixDirty=true;return;}
 const canvas=document.createElement('canvas');
 try{
  canvas.width=previewWidth;canvas.height=previewHeight;
  const ctx=canvas.getContext('2d',{willReadFrequently:true});
  if(!ctx)throw new Error('Not enough browser memory to align Map 2.');
  drawDetailTo(ctx,layer.image,previewWidth,previewHeight,layer.settings.fit);
  const image=ctx.getImageData(0,0,previewWidth,previewHeight);
  const result=await engine.request('prepareDepth2',{buffer:image.data.buffer,encoding:layer.settings.encoding},[image.data.buffer]);
  layer.mode=result.mode;layer.values=new Uint16Array(result.values);
  layer.previewData=new ImageData(new Uint8ClampedArray(result.buffer),previewWidth,previewHeight);
  depthMixDirty=true;depthPaintKey='';
 }finally{canvas.width=canvas.height=1;}
}
async function refreshDepth2Preview(){
 if(!ready||working||exporting)return;
 setBusy(true,'Reading and aligning Map 2…');version++;pickedPoints={1:null,2:null};
 try{await prepareDepth2Preview();}
 catch(error){secondaryDepth.settings.enabled=false;depthMixDirty=true;toast(error.message,true);}
 finally{setBusy(false);queueRender();}
}
async function loadDepth2Image(input,name){
 if(!ready||working||exporting)return false;
 try{validateImageFile(input);}catch(error){toast(error.message,true);return false;}
 const previous={...secondaryDepth,settings:{...secondaryDepth.settings}};
 setBusy(true,'Reading the second depth map…');version++;let decoded=null;
 try{
  decoded=await decodeImage(input);const {w,h}=validateImageSize(decoded);
  secondaryDepth={...secondaryDepth,image:decoded,width:w,height:h,name:name||'depth-map-2.png',settings:{...secondaryDepth.settings,enabled:true}};
  await prepareDepth2Preview();
  if(previous.image&&previous.image!==decoded&&previous.image.close)previous.image.close();decoded=null;
  depthPreview='mixed';view='focus';picking=false;holdSource=false;pickedPoints={1:null,2:null};
  if($('depthDialog').open)$('depthDialog').close();
  toast(depthMixCompatible()?'Map 2 loaded · '+(100-secondaryDepth.settings.weight)+' / '+secondaryDepth.settings.weight+' depth blend.':'Map 2 loaded, but hue is not a depth scale. Choose the correct encoding in depth options.',!depthMixCompatible());
  return true;
 }catch(error){
  if(decoded&&decoded.close)decoded.close();secondaryDepth=previous;
  try{await prepareDepth2Preview();}catch(_){secondaryDepth.settings.enabled=false;}
  toast(error.message||'Unable to read Map 2. Try PNG, JPEG or WebP.',true);return false;
 }finally{depthMixDirty=true;setBusy(false);queueRender();}
}
async function removeDepth2(){
 if(working||exporting)return;
 setBusy(true,'Removing Map 2…');version++;
 const old=secondaryDepth;
 secondaryDepth={settings:{...old.settings,enabled:false},image:null,width:0,height:0,name:'',mode:'gray',previewData:null,values:null};
 if(old.image?.close)old.image.close();depthPreview='mixed';pickedPoints={1:null,2:null};
 try{await prepareDepth2Preview();toast('Map 2 removed. Map 1 and both detail slots are unchanged.');}
 catch(error){toast(error.message,true);}
 finally{depthMixDirty=true;setBusy(false);queueRender();}
}
function touchDepthMix(){
 depthMixDirty=true;pickedPoints={1:null,2:null};queueRender();
}

function syncDetailControls(){
 const locked=working||exporting;
 const key=JSON.stringify([locked,ready,activeDetail,sourceWidth,sourceHeight,
   ...detailLayers.map(l=>[Boolean(l.image),l.width,l.height,l.name,l.settings])]);
 if(detailControlsKey===key)return;detailControlsKey=key;
 detailLayers.forEach((layer,index)=>{
  const {settings,image,width,height,name}=layer,has=Boolean(image),id=stem=>detailId(stem,index);
  $(id('detailEnabled')).checked=has&&settings.enabled;
  $(id('detailEnabled')).disabled=!has||locked;
  $(id('detailBlend')).value=settings.blend;$(id('detailBlend')).disabled=!has||locked;
  const input=$(id('detailOpacity'));input.value=settings.opacity;
  input.style.setProperty('--fill',settings.opacity+'%');input.disabled=!has||locked;
  $(id('detailOpacity')+'Value').textContent=settings.opacity+'%';
  $(id('loadDetailBtn')).disabled=locked||!ready;
  $(id('detailOptionsBtn')).disabled=locked;
  $(id('detailViewBtn')).disabled=!has||locked;
  $('detailSelect'+(index+1)).disabled=locked;
  setAttr($('detailSelect'+(index+1)),'aria-pressed',activeDetail===index);
  const card=$('detailCard'+(index+1));card.classList.toggle('selected',activeDetail===index);
  setAttr(card,'data-active',has&&settings.enabled&&settings.opacity>0);
  $(id('detailFileName')).textContent=has?name:'No image loaded';
  $(id('detailFileName')).title=has?name+' · '+width+' × '+height:'';
  $(id('detailState')).textContent=!has?'Empty':!settings.enabled?'Bypassed':settings.opacity===0?'0% · no effect':'Grayscale';
 });
 const layer=detailLayers[activeDetail],{settings,image,width,height,name}=layer,has=Boolean(image);
 $('detailDialogTitle').textContent='Detail '+(activeDetail+1)+' options';
 document.querySelectorAll('[data-edit-detail]').forEach(b=>{b.setAttribute('aria-pressed',String(Number(b.dataset.editDetail)===activeDetail));b.disabled=locked;});
 $('detailFit').value=settings.fit;$('detailFit').disabled=locked;
 for(const id of ['loadDetailDialogBtn','detailExampleBtn'])$(id).disabled=locked||!ready;
 $('removeDetailBtn').disabled=!has||locked;$('showDetailBtn').disabled=!has||locked;
 $('swapDetailsBtn').disabled=locked||!ready||!detailLayers.some(l=>l.image);
 const info=$('detailImageInfo');info.replaceChildren();
 if(has){
  const label=document.createElement('strong');label.textContent=name;
  info.append(label,document.createElement('br'),document.createTextNode('Detail '+(activeDetail+1)+': '+width.toLocaleString()+' × '+height.toLocaleString()+' px'),document.createElement('br'),document.createTextNode('Output: '+sourceWidth.toLocaleString()+' × '+sourceHeight.toLocaleString()+' px (depth size)'));
 }else info.textContent='No image in Detail '+(activeDetail+1)+'. This layer does not affect the result.';
 const note=$('detailAlignmentNote'),mismatch=has&&sourceWidth>0&&Math.abs((width/height)/(sourceWidth/sourceHeight)-1)>.006;
 note.classList.toggle('warning',mismatch);
 if(!has)note.textContent='Different pixel dimensions are fine. Use images of the same scene and framing. Resizing does not recognise or register objects.';
 else if(mismatch)note.textContent='Different aspect ratios. '+(settings.fit==='stretch'?'Match frame stretches this layer to cover the depth image.':settings.fit==='cover'?'Fill frame preserves proportions and crops the centre.':'Fit inside preserves proportions, with no effect outside the fitted image.')+' Check D'+(activeDetail+1)+'; a different crop or camera angle needs external alignment.';
 else note.textContent='Matching aspect ratios. This layer is resampled to the depth map, so different pixel dimensions are fine. Images still need to show the same scene and framing.';
}
function selectDetailLayer(index){
 if((index!==0&&index!==1)||working||exporting)return;
 activeDetail=index;
 if(detailIndexForView()>=0)view=detailLayers[index].image?detailViewName(index):'focus';
 syncDetailControls();updateView();
}
let detailPaintRef=null,detailPaintWidth=0,detailPaintHeight=0,detailPaintValid=false;
function paintDetailPreview(index){
 const data=detailLayers[index]?.previewData;
 if(detailPaintValid&&data===detailPaintRef&&detailPaintWidth===previewWidth&&detailPaintHeight===previewHeight)return;
 detailPaintValid=true;detailPaintRef=data;detailPaintWidth=previewWidth;detailPaintHeight=previewHeight;
 detailCtx.clearRect(0,0,previewWidth,previewHeight);
 if(data&&data.width===previewWidth&&data.height===previewHeight)detailCtx.putImageData(data,0,0);
}
function openDetailOptions(index=activeDetail){
 if(working||exporting)return;
 if(index!==0&&index!==1)index=activeDetail;
 selectDetailLayer(index);
 if($('settingsDialog').open)$('settingsDialog').close();
 syncDetailControls();if(!$('detailDialog').open)$('detailDialog').showModal();
}
function imageDimensions(image){return {w:image.naturalWidth||image.width,h:image.naturalHeight||image.height};}
function validateImageSize(image){
 const {w,h}=imageDimensions(image);
 if(!w||!h)throw new Error('The image is empty or could not be decoded.');
 if(w*h>40000000||w>16384||h>16384)throw new Error('This image is too large. Use at most 40 megapixels and 16,384 pixels on either side.');
 return {w,h};
}
function validateImageFile(input){
 if(typeof input==='string')return;
 if(input.size>100*1024*1024)throw new Error('Please use an image file smaller than 100 MB.');
 if(/\.(svg|tiff?|exr|hdr|heic|heif)$/i.test(input.name||'')||input.type==='image/svg+xml')throw new Error('Please convert this to PNG, JPEG, WebP, AVIF or BMP first. SVG, TIFF, EXR and HEIC are not supported.');
}
function alignedRect(image,width,height,fit){
 const {w,h}=imageDimensions(image);
 if(fit==='stretch')return {x:0,y:0,w:width,h:height};
 const scale=fit==='cover'?Math.max(width/w,height/h):Math.min(width/w,height/h);
 return {x:(width-w*scale)/2,y:(height-h*scale)/2,w:w*scale,h:h*scale};
}
function drawDetailTo(ctx,image,width,height,fit,stripY=0,stripHeight=height){
 const r=alignedRect(image,width,height,fit);
 ctx.clearRect(0,0,width,stripHeight);
 ctx.imageSmoothingEnabled=true;
 if('imageSmoothingQuality' in ctx)ctx.imageSmoothingQuality='high';
 // Use full-image destination coordinates even for an export strip. This keeps
 // alignment and resampling continuous rather than resizing each strip anew.
 ctx.drawImage(image,r.x,r.y-stripY,r.w,r.h);
}
async function prepareDetailPreview(index=null){
 detailPaintValid=false;
 if(detailCanvas.width!==previewWidth||detailCanvas.height!==previewHeight){
  detailCanvas.width=previewWidth;detailCanvas.height=previewHeight;
 }
 const indices=index===null?[0,1]:[index];
 for(const n of indices){
  const layer=detailLayers[n];
  if(!layer.image){layer.previewData=null;await engine.request('prepareDetail',{index:n,buffer:null});continue;}
  drawDetailTo(detailCtx,layer.image,previewWidth,previewHeight,layer.settings.fit);
  const image=detailCtx.getImageData(0,0,previewWidth,previewHeight);
  const result=await engine.request('prepareDetail',{index:n,buffer:image.data.buffer},[image.data.buffer]);
  layer.previewData=new ImageData(new Uint8ClampedArray(result.buffer),previewWidth,previewHeight);
 }
 paintDetailPreview(detailIndexForView()>=0?detailIndexForView():activeDetail);
}
async function refreshDetailPreview(index=null){
 if(!ready||working||exporting)return;
 setBusy(true,index===null?'Aligning the detail layers…':'Aligning Detail '+(index+1)+'…');version++;
 try{await prepareDetailPreview(index);}
 catch(error){for(const n of index===null?[0,1]:[index])detailLayers[n].settings.enabled=false;toast(error.message,true);}
 finally{setBusy(false);queueRender();}
}
async function loadDetailImage(input,name,isExample=false,index=activeDetail){
 if(!ready||working||exporting||![0,1].includes(index))return false;
 try{validateImageFile(input);}catch(error){toast(error.message,true);return false;}
 setBusy(true,'Preparing Detail '+(index+1)+' in grayscale…');version++;
 const layer=detailLayers[index],previous={...layer,settings:{...layer.settings}};
 let decoded=null;
 try{
  decoded=await decodeImage(input);const {w,h}=validateImageSize(decoded);
  layer.image=decoded;layer.width=w;layer.height=h;layer.name=name||'detail-image.png';
  layer.settings={...layer.settings,enabled:true};
  if(isExample)layer.settings.fit='stretch';
  await prepareDetailPreview(index);
  if(previous.image&&previous.image!==decoded&&previous.image.close)previous.image.close();
  decoded=null;activeDetail=index;view='focus';picking=false;holdSource=false;
  if($('detailDialog').open)$('detailDialog').close();
  if(!isExample)toast('Detail '+(index+1)+' loaded in grayscale · '+w.toLocaleString()+' × '+h.toLocaleString()+'.');
  return true;
 }catch(error){
  if(decoded&&decoded.close)decoded.close();detailLayers[index]=previous;
  try{await prepareDetailPreview(index);}catch(_){previous.settings.enabled=false;}
  toast(error.message||'Unable to open this detail image. Try PNG, JPEG or WebP.',true);return false;
 }finally{setBusy(false);queueRender();}
}
async function removeDetail(index=activeDetail){
 if(working||exporting||![0,1].includes(index))return;
 setBusy(true,'Removing Detail '+(index+1)+'…');version++;
 const old=detailLayers[index];if(old.image&&old.image.close)old.image.close();
 detailLayers[index]={...makeDetailLayer(),settings:{...old.settings,enabled:false}};
 if(detailIndexForView()===index)view='focus';
 try{await prepareDetailPreview(index);toast('Detail '+(index+1)+' removed. The other layer is unchanged.');}
 catch(error){toast(error.message,true);}
 finally{setBusy(false);queueRender();}
}
function toggleDetail(index=activeDetail){
 const layer=detailLayers[index];if(!layer?.image||working||exporting)return;
 layer.settings.enabled=!layer.settings.enabled;queueRender();
}
async function swapDetailLayers(){
 if(working||exporting||!ready)return;
 const oldViewIndex=detailIndexForView();
 setBusy(true,'Swapping the detail layers…');version++;
 detailLayers.reverse();activeDetail=1-activeDetail;
 if(oldViewIndex>=0)view=detailViewName(1-oldViewIndex);
 try{await prepareDetailPreview();toast('Layers swapped. Detail 1 blends first, then Detail 2.');}
 catch(error){detailLayers.forEach(layer=>layer.settings.enabled=false);toast(error.message,true);}
 finally{setBusy(false);queueRender();}
}

// v8: independent plane rotation and translation. No spatial hue offsets.
const vec={
 dot:(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2],
 cross:(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]],
 add:(a,b)=>a.map((x,i)=>x+b[i]), sub:(a,b)=>a.map((x,i)=>x-b[i]),
 mul:(a,k)=>a.map(x=>x*k), unit:a=>{const l=Math.hypot(...a);return l>1e-12?a.map(x=>x/l):[0,0,1];}
};
let sceneFramePending=false,sceneDepthRef=null,scenePoints=[],sceneAspectKey='',sceneCameraKey='',sceneSorted=[],sceneDrag=null;
let showPlaneGuides=true;
function planeActive(focus=activeFocus){return Boolean(params.advanced&&resolvedMode!=='hue'&&params.planes[focus-1].enabled&&(focus===1||params.secondEnabled));}
function frameAspect(){return sourceWidth&&sourceHeight?sourceWidth/sourceHeight:1;}
function normalToAngles(normal){const n=vec.unit(normal);return {yaw:Math.atan2(n[0],n[2])*180/Math.PI,pitch:-Math.asin(clamp(n[1],-1,1))*180/Math.PI};}
function setPlaneCenter(value,focus=activeFocus){
 const key=focusKey('center',focus);params[key]=clamp(value,0,100);
 params.planes[focus-1].pivot.depth=params[key];
 // Ordinary position changes establish a new flat-band pivot, but keep the
 // hidden orientation and slide settings for the next advanced session.
 pickedPoints[focus]=null;
}
function resetPlanesForImage(){params.advanced=false;params.planes=[makePlane(params.center),makePlane(params.center2)];sceneDepthRef=null;sceneDrag=null;}
function setAdvanced(on){
 if(working||exporting)return;
 params.advanced=Boolean(on);picking=false;holdSource=false;sceneDrag=null;
 if(on)for(let i=0;i<2;i++){
  params.planes[i].enabled=true;
  const point=pickedPoints[i+1];
  if(point&&params.planes[i].yaw===0&&params.planes[i].pitch===0){params.planes[i].pivot.x=point.x;params.planes[i].pivot.y=point.y;}
 }
 touchSettings();requestAnimationFrame(()=>{fitImage();queuePlaneDraw();});
 if(on&&resolvedMode==='hue')toast('3D planes need Spectral or grayscale depth. Choose the map encoding in settings.',true);
}
function syncPlaneControls(){
 const available=resolvedMode!=='hue',locked=working||exporting,active=planeActive();
 const pl=params.planes[activeFocus-1];
 document.body.dataset.advanced=String(params.advanced);
 $('advancedMode').checked=params.advanced;$('advancedMode').disabled=locked;
 $('advancedTools').hidden=!params.advanced;
 $('guidesToggle').hidden=!available;$('showGuides').checked=showPlaneGuides;
 $('planeWarning').hidden=!params.advanced||available;
 $('planeDock').hidden=!params.advanced;
 $('planeDock').dataset.focus=String(activeFocus);
 $('planeDockTitle').textContent='Rotate plane '+focusLetter();
 $('planeCanvas').setAttribute('aria-disabled',String(!active||locked));
 $('planeCanvas').setAttribute('aria-label','Rotate plane '+focusLetter()+' in 3D. Drag to rotate. Arrow keys adjust angles; Home makes it face-on.');
 for(const [key,id] of [['yaw','planeYaw'],['pitch','planePitch']]){
  const input=$(id),v=pl[key];input.value=v;input.disabled=locked||!active;
  input.style.setProperty('--fill',(v-Number(input.min))/(Number(input.max)-Number(input.min))*100+'%');
  $(id+'Value').textContent=(v>0?'+':'')+v.toFixed(1).replace(/\.0$/,'')+'°';
 }
 $('faceOnBtn').disabled=locked||!active;
 $('sceneView').disabled=locked;
 $('sceneHint').textContent=available?'Drag to rotate '+focusLetter():'Use scalar depth';
 for(const [n,L] of [[1,'A'],[2,'B']]){
  const p=params.planes[n-1],on=planeActive(n),exists=n===1||params.secondEnabled;
  $('flatPosition'+L).hidden=params.advanced&&available;
  $('slideRow'+L).hidden=!params.advanced||!available;
  const input=$('planeSlide'+L);input.value=p.slide;input.disabled=locked||!on;
  input.style.setProperty('--fill',(p.slide+100)/2+'%');
  $('planeSlide'+L+'Value').textContent=(p.slide>0?'+':'')+p.slide.toFixed(1).replace(/\.0$/,'')+'%';
  $('widthLabel'+L).textContent=params.advanced&&available?'Thickness':'Width';
  $('widthLabel'+L).parentElement.title=params.advanced&&available?'Full band thickness perpendicular to the plane, in percent of the normalized depth range.':'Full selected depth-band width.';
  $('editPlane'+L).setAttribute('aria-pressed',String(activeFocus===n));$('editPlane'+L).disabled=locked;
  const pick=$(n===1?'pickBtn':'pickBtnB');pick.title=params.advanced&&available?'Pick pivot '+L+' on a subject; keep this plane’s rotation and zero its slide':'Pick focus '+L+' from the image';
  pick.setAttribute('aria-label',params.advanced&&available?'Pick rotation pivot for plane '+L:'Pick focus '+L+' from image');
 }
 const n=local.planeNormal(pl),angle=Math.acos(clamp(Math.abs(n[2]),0,1))*180/Math.PI;
 $('planeReadout').textContent=available?(angle<.05?'Face-on':angle>89.95?'Edge-on':angle.toFixed(1)+'° from face-on')+' · pivot '+pl.pivot.depth.toFixed(1)+'%\nSlide moves the plane along the + arrow.':'Hue is circular colour selection, not a linear depth axis. 3D focus is paused.';
 queuePlaneDraw();
}
function syncPlaneGuides(){
 const visible=params.advanced&&resolvedMode!=='hue'&&(showPlaneGuides||picking)&&!(detailIndexForView()>=0&&!picking&&!holdSource);
 for(const [n,L] of [[1,'A'],[2,'B']]){
  const pin=$('pivot'+L),p=params.planes[n-1];pin.hidden=!visible||!planeActive(n);
  pin.style.left=p.pivot.x*100+'%';pin.style.top=p.pivot.y*100+'%';pin.style.zIndex=n===activeFocus?'7':'6';
  pin.setAttribute('aria-pressed',String(n===activeFocus));pin.disabled=working||exporting;
  pin.setAttribute('aria-label','Plane '+L+' rotation pivot at '+p.pivot.depth.toFixed(1)+' percent depth. Drag to place on a new subject.');
 }
}
function queuePlaneDraw(){if(sceneFramePending)return;sceneFramePending=true;requestAnimationFrame(()=>{sceneFramePending=false;drawPlaneScene();});}
function sceneCamera(){
 const type=$('sceneView').value;
 const angles={oblique:[28,18],front:[0,0],side:[90,0],top:[0,90]};
 const [yaw,pitch]=angles[type]||angles.oblique,az=yaw*Math.PI/180,el=pitch*Math.PI/180;
 return {type,right:[Math.cos(az),0,Math.sin(az)],up:[-Math.sin(az)*Math.sin(el),Math.cos(el),Math.cos(az)*Math.sin(el)],toward:[Math.sin(az)*Math.cos(el),Math.sin(el),-Math.cos(az)*Math.cos(el)]};
}
function volumeCorners(sx,sy){return Array.from({length:8},(_,i)=>[(i&1?1:-1)*sx/2,(i&2?1:-1)*sy/2,(i&4?1:-1)*.5]);}
function volumeEdges(){const edges=[];for(let i=0;i<8;i++)for(const bit of [1,2,4])if(!(i&bit))edges.push([i,i|bit]);return edges;}
function clippedPlane(normal,constant,corners){
 const points=[];
 function add(p){if(!points.some(q=>Math.hypot(...vec.sub(q,p))<1e-7))points.push(p);}
 for(const [a,b] of volumeEdges()){
  const p=corners[a],q=corners[b],dp=vec.dot(normal,p)-constant,dq=vec.dot(normal,q)-constant;
  if(Math.abs(dp)<1e-9)add(p);if(Math.abs(dq)<1e-9)add(q);
  if(dp*dq<0){const t=dp/(dp-dq);add(p.map((x,i)=>x+(q[i]-x)*t));}
 }
 if(points.length<3)return [];
 const center=points.reduce((sum,p)=>vec.add(sum,vec.mul(p,1/points.length)),[0,0,0]);
 const u=vec.unit(vec.cross(Math.abs(normal[1])<.9?[0,1,0]:[1,0,0],normal)),v=vec.cross(normal,u);
 return points.sort((p,q)=>{const a=vec.sub(p,center),b=vec.sub(q,center);return Math.atan2(vec.dot(a,v),vec.dot(a,u))-Math.atan2(vec.dot(b,v),vec.dot(b,u));});
}
function cloudPoints(camera){
 const aspect=frameAspect(),key=previewWidth+'|'+previewHeight+'|'+aspect;
 if(sceneDepthRef!==depthValues||sceneAspectKey!==key){
  sceneDepthRef=depthValues;sceneAspectKey=key;sceneCameraKey='';scenePoints=[];
  if(!depthValues)return scenePoints;
  const sx=aspect>=1?1:aspect,sy=aspect>=1?1/aspect:1;
  const step=Math.max(1,Math.ceil(Math.sqrt(depthValues.length/6500)));
  for(let y=0;y<previewHeight;y+=step)for(let x=0;x<previewWidth;x+=step){
   const pos=y*previewWidth+x,d=depthValues[pos];
   if(d===local.INVALID||(primaryAlpha?.[pos]??255)<16)continue;
   scenePoints.push([((x+.5)/previewWidth-.5)*sx,(.5-(y+.5)/previewHeight)*sy,d/local.LAST-.5]);
  }
 }
 if(sceneCameraKey!==camera.type){sceneCameraKey=camera.type;sceneSorted=scenePoints.slice().sort((a,b)=>vec.dot(a,camera.toward)-vec.dot(b,camera.toward));}
 return sceneSorted;
}
function drawPlaneScene(){
 if(!$('planeDock')||$('planeDock').hidden)return;
 const canvas=$('planeCanvas'),rect=canvas.getBoundingClientRect();if(rect.width<1||rect.height<1)return;
 const dpr=Math.min(window.devicePixelRatio||1,2),w=rect.width,h=rect.height;
 const pixelW=Math.round(w*dpr),pixelH=Math.round(h*dpr);
 if(canvas.width!==pixelW||canvas.height!==pixelH){canvas.width=pixelW;canvas.height=pixelH;}
 const ctx=canvas.getContext('2d');if(!ctx)return;
 ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,w,h);
 if(!params.advanced||!ready||resolvedMode==='hue'){
  ctx.fillStyle='#b8b8b8';ctx.font='10px ui-monospace,monospace';ctx.textAlign='center';ctx.fillText(ready?'Choose scalar depth':'Preparing depth…',w/2,h/2);return;
 }
 const camera=sceneCamera(),p=snapshotParams(),a=local.focusPlane(p,0,resolvedMode,sourceWidth,sourceHeight),b=local.focusPlane(p,1,resolvedMode,sourceWidth,sourceHeight),corners=volumeCorners(a.sx,a.sy);
 const coords=corners.map(q=>[vec.dot(q,camera.right),-vec.dot(q,camera.up)]);
 const minX=Math.min(...coords.map(q=>q[0])),maxX=Math.max(...coords.map(q=>q[0])),minY=Math.min(...coords.map(q=>q[1])),maxY=Math.max(...coords.map(q=>q[1]));
 const scale=Math.max(1,Math.min((w-32)/(maxX-minX||1),(h-49)/(maxY-minY||1)));
 const cx=w/2-(minX+maxX)/2*scale,cy=h/2+1-(minY+maxY)/2*scale;
 const project=q=>[cx+vec.dot(q,camera.right)*scale,cy-vec.dot(q,camera.up)*scale];
 function line(p1,p2,color,width=1,dashed=false){const u=project(p1),v=project(p2);ctx.strokeStyle=color;ctx.lineWidth=width;ctx.setLineDash(dashed?[3,3]:[]);ctx.beginPath();ctx.moveTo(...u);ctx.lineTo(...v);ctx.stroke();ctx.setLineDash([]);}
 function polygon(points,color,fill,dashed=false){if(points.length<3)return;ctx.beginPath();points.forEach((q,i)=>{const r=project(q);i?ctx.lineTo(...r):ctx.moveTo(...r);});ctx.closePath();if(fill){ctx.fillStyle=fill;ctx.fill();}ctx.lineWidth=1.1;ctx.strokeStyle=color;ctx.setLineDash(dashed?[3,3]:[]);ctx.stroke();ctx.setLineDash([]);}
 for(const [i,j] of volumeEdges())line(corners[i],corners[j],'#aaaaaa66',.7);
 const planes=[a,b],bandColors=['139,201,237','239,188,135'];
 for(const index of [1-(activeFocus-1),activeFocus-1]){
  if(index===1&&!params.secondEnabled)continue;
  const q=planes[index],active=index===activeFocus-1,color=bandColors[index],width=(index===0?params.width:params.width2)/200;
  if(active){
   polygon(clippedPlane(q.normal,q.constant-width,corners),`rgba(${color},.25)`,`rgba(${color},.025)`,true);
   polygon(clippedPlane(q.normal,q.constant+width,corners),`rgba(${color},.25)`,`rgba(${color},.025)`,true);
  }
  polygon(clippedPlane(q.normal,q.constant,corners),`rgba(${color},${active?.9:.35})`,`rgba(${color},${active?.16:.03})`,!active);
 }
 const shades=bandColors.map(color=>{const rgb=color.split(',').map(Number);return Array.from({length:33},(_,i)=>{const t=i/32;return 'rgb('+rgb.map((v,j)=>Math.round([103,103,103][j]+(v-[103,103,103][j])*t)).join(',')+')';});});
 const dot=Math.max(1,Math.min(2,scale/145)),pointTone={...p,background:0,invert:false};
 for(const point of cloudPoints(camera)){
  const wa=local.windowValue(local.planeDistance(point,a),p),wb=p.secondEnabled?local.windowValue(local.planeDistance(point,b),p,true):0;
  const weight=Math.max(wa,wb),bright=weight>0?Math.max(.1,local.shapeTone(weight,pointTone)):0;
  ctx.fillStyle=shades[wb>wa?1:0][Math.round(clamp(bright,0,1)*32)];const xy=project(point);ctx.fillRect(xy[0]-dot/2,xy[1]-dot/2,dot,dot);
 }
 const q=planes[activeFocus-1],rgb=bandColors[activeFocus-1],onPlane=vec.add(q.pivot,vec.mul(q.normal,q.slide));
 const end=vec.add(onPlane,vec.mul(q.normal,.18)),pos=project(onPlane),tip=project(end),pivot=project(q.pivot);
 // The pivot and normal arrow explain why translation and rotation differ.
 if(Math.abs(q.slide)>.005)line(q.pivot,onPlane,`rgba(${rgb},.65)`,1,true);
 line(onPlane,end,`rgb(${rgb})`,1.6);
 const arrowAngle=Math.atan2(tip[1]-pos[1],tip[0]-pos[0]);
 ctx.fillStyle=`rgb(${rgb})`;ctx.beginPath();ctx.moveTo(...tip);ctx.lineTo(tip[0]-6*Math.cos(arrowAngle-.45),tip[1]-6*Math.sin(arrowAngle-.45));ctx.lineTo(tip[0]-6*Math.cos(arrowAngle+.45),tip[1]-6*Math.sin(arrowAngle+.45));ctx.closePath();ctx.fill();
 ctx.strokeStyle=`rgb(${rgb})`;ctx.fillStyle='#252525';ctx.lineWidth=1.3;ctx.beginPath();ctx.arc(pivot[0],pivot[1],3.5,0,Math.PI*2);ctx.fill();ctx.stroke();
 ctx.font='9px ui-monospace,monospace';ctx.textAlign='left';ctx.fillStyle=`rgb(${rgb})`;ctx.fillText(focusLetter(),pivot[0]+6,pivot[1]-4);ctx.fillText('+',tip[0]+3,tip[1]-3);
 ctx.font='8px ui-monospace,monospace';ctx.fillStyle='#aaaaaa';
 const labels=[[corners[1],'X'],[corners[2],'Y'],[corners[0],'0'],[corners[4],'1']];
 for(const [pt,label] of labels){const xy=project(pt);ctx.fillText(label,clamp(xy[0]+3,3,w-8),clamp(xy[1]+8,24,h-17));}
 if(!clippedPlane(q.normal,q.constant,corners).length){ctx.textAlign='center';ctx.fillStyle=`rgb(${rgb})`;ctx.fillText('Outside volume · adjust Slide',w/2,h-22);}
}
function arcVector(event,rect){
 const radius=Math.max(1,Math.min(rect.width,rect.height)*.43),x=(event.clientX-rect.left-rect.width/2)/radius,y=(rect.height/2-event.clientY+rect.top)/radius,r2=x*x+y*y;
 return r2<=1?[x,y,Math.sqrt(1-r2)]:vec.unit([x,y,0]);
}
function toSceneVector(v,camera){return vec.add(vec.add(vec.mul(camera.right,v[0]),vec.mul(camera.up,v[1])),vec.mul(camera.toward,v[2]));}
function rotateVector(v,axis,angle){const c=Math.cos(angle),s=Math.sin(angle);return vec.add(vec.add(vec.mul(v,c),vec.mul(vec.cross(axis,v),s)),vec.mul(axis,vec.dot(axis,v)*(1-c)));}
function stopSceneDrag(){sceneDrag=null;$('planeCanvas').dataset.dragging='false';}

function syncPins(){
 for(const [n,letter] of [[1,'A'],[2,'B']]){
  const point=pickedPoints[n],pin=$('pin'+letter);
  pin.hidden=planeActive(n)||!point||(n===2&&!params.secondEnabled)||(detailIndexForView()>=0&&!picking&&!holdSource);
  if(point){pin.style.left=point.x*100+'%';pin.style.top=point.y*100+'%';}
 }
 syncPlaneGuides();
}
function selectFocus(focus,enableSecond=false){
 if(working||exporting)return false;
 const wasEnabled=params.secondEnabled;
 if(focus===2&&!params.secondEnabled){if(!enableSecond)return false;params.secondEnabled=true;}
 if(activeFocus!==focus)activePreset='';
 activeFocus=focus;
 updateView();
 if(wasEnabled!==params.secondEnabled)touchSettings();else syncControls();
 return true;
}
function togglePicker(focus){
 if(!ready||working||exporting)return;
 const wasPicking=picking&&activeFocus===focus;
 if(!selectFocus(focus,true))return;
 picking=!wasPicking;
 updateView();
}
function drawCurve(){
 const canvas=$('curveCanvas'),rect=canvas.getBoundingClientRect(),dpr=Math.min(window.devicePixelRatio||1,2);
 if(rect.width<1||rect.height<1)return;
 const w=rect.width,h=rect.height,pixelW=Math.round(w*dpr),pixelH=Math.round(h*dpr);
 if(canvas.width!==pixelW||canvas.height!==pixelH){canvas.width=pixelW;canvas.height=pixelH;}
 const ctx=canvas.getContext('2d');ctx.setTransform(dpr,0,0,dpr,0,0);const theme=graphTheme();
 const left=8,right=w-8,top=15,base=h-24,bottom=h-7,pw=right-left,ph=base-top;
 ctx.fillStyle=theme.paper;ctx.fillRect(0,0,w,h);
 ctx.strokeStyle=theme.rule;ctx.lineWidth=1;
 for(let i=0;i<3;i++){const y=top+i*ph/2;ctx.beginPath();ctx.moveTo(left,y+.5);ctx.lineTo(right,y+.5);ctx.stroke();}
 const max=Math.max(1,...histogram);ctx.fillStyle=theme.hist;ctx.beginPath();ctx.moveTo(left,base);
 for(let i=0;i<256;i++)ctx.lineTo(left+i/255*pw,base-Math.sqrt(histogram[i]/max)*ph*.8);
 ctx.lineTo(right,base);ctx.closePath();ctx.fill();
 // The filled curve is the final composite. Dashed curves show each band.
 const count=Math.ceil(pw);
 function pathFor(p){ctx.beginPath();for(let i=0;i<=count;i++){const t=i/count,x=left+t*pw,y=base-local.tone(t,p,resolvedMode)*ph;i?ctx.lineTo(x,y):ctx.moveTo(x,y);}}
 pathFor(params);ctx.lineTo(right,base);ctx.lineTo(left,base);ctx.closePath();ctx.fillStyle=theme.wash;ctx.fill();
 if(params.secondEnabled){
  const individualA={...params,secondEnabled:false};
  const individualB={...individualA,center:params.center2,width:params.width2,softness:params.softness2};
  ctx.setLineDash([3,3]);ctx.lineWidth=1;
  pathFor(individualA);ctx.strokeStyle=theme.a+'90';ctx.stroke();
  pathFor(individualB);ctx.strokeStyle=theme.b+'90';ctx.stroke();ctx.setLineDash([]);
 }
 pathFor(params);ctx.strokeStyle=theme.line;ctx.lineWidth=1.5;ctx.stroke();
 for(let x=0;x<count;x++){const rgb=local.colour(x/pw,resolvedMode).map(Math.round);ctx.fillStyle=`rgb(${rgb.join(',')})`;ctx.fillRect(left+x,base+6,1.2,bottom-base-6);}
 // Only the active band's edge handles are draggable.
 const c=params[focusKey('center')]/100,half=params[focusKey('width')]/200;
 let positions=[c-half,c+half];if(resolvedMode==='hue')positions=positions.map(t=>(t+1)%1);
 const accent=activeFocus===2?theme.b:theme.a;
 ctx.setLineDash([2,3]);ctx.lineWidth=1;ctx.strokeStyle=accent+'80';
 for(const p of positions)if(p>=0&&p<=1){const x=left+p*pw;ctx.beginPath();ctx.moveTo(x,top);ctx.lineTo(x,bottom);ctx.stroke();ctx.setLineDash([]);ctx.fillStyle=accent;ctx.fillRect(x-2,bottom-7,4,9);ctx.setLineDash([2,3]);}
 ctx.setLineDash([]);
 for(const n of [1,2]){
  if(n===2&&!params.secondEnabled)continue;
  const cx=left+params[focusKey('center',n)]/100*pw;
  const color=n===2?theme.b:theme.a;
  ctx.strokeStyle=color;ctx.lineWidth=n===activeFocus?1.4:.8;
  ctx.beginPath();ctx.moveTo(cx,top);ctx.lineTo(cx,bottom+1);ctx.stroke();
  ctx.fillStyle=color;ctx.font='9px ui-monospace,monospace';ctx.textAlign='center';
  ctx.fillText(n===2?'B':'A',Math.max(left+4,Math.min(right-4,cx)),top-4);
 }
}


function imageMetrics(){
 if(!sourceWidth||!sourceHeight)return null;
 const stage=$('viewport'),css=getComputedStyle(stage),rect=stage.getBoundingClientRect();
 const left=parseFloat(css.paddingLeft)||0,top=parseFloat(css.paddingTop)||0;
 const width=Math.max(1,stage.clientWidth-left-(parseFloat(css.paddingRight)||0));
 const height=Math.max(1,stage.clientHeight-top-(parseFloat(css.paddingBottom)||0));
 const fit=Math.max(.00001,Math.min(MAX_IMAGE_ZOOM,width/sourceWidth,height/sourceHeight));
 return {left,top,width,height,clientLeft:rect.left+left,clientTop:rect.top+top,fit,min:Math.min(.1,fit)};
}
function zoomPercent(scale){const n=scale*100;return (n<10?n.toFixed(1):Math.round(n))+ '%';}
function navigationPoint(clientX,clientY){
 const m=imageMetrics();if(!m)return {x:.5,y:.5};
 return {x:navigation.centerX+(clientX-m.clientLeft-m.width/2)/(sourceWidth*navigation.scale),y:navigation.centerY+(clientY-m.clientTop-m.height/2)/(sourceHeight*navigation.scale)};
}
function fitImage(){
 const m=imageMetrics();if(!m||!previewWidth)return;
 const w=$('imageWindow');
 w.style.left=m.left+'px';w.style.top=m.top+'px';w.style.width=m.width+'px';w.style.height=m.height+'px';
 if(navigation.fit){navigation.scale=m.fit;navigation.centerX=navigation.centerY=.5;}
 else navigation.scale=clamp(navigation.scale,m.min,MAX_IMAGE_ZOOM);
 const width=sourceWidth*navigation.scale,height=sourceHeight*navigation.scale;
 const halfX=m.width/(2*width),halfY=m.height/(2*height);
 navigation.centerX=width<=m.width?.5:clamp(navigation.centerX,halfX,1-halfX);
 navigation.centerY=height<=m.height?.5:clamp(navigation.centerY,halfY,1-halfY);
 const left=m.width/2-width*navigation.centerX,top=m.height/2-height*navigation.centerY;
 imageLayout={...m,imageWidth:width,imageHeight:height,imageLeft:left,imageTop:top};
 const frame=$('imageFrame');frame.style.width=width+'px';frame.style.height=height+'px';
 frame.style.left=left+'px';frame.style.top=top+'px';frame.style.visibility='visible';
 syncNavigation();layoutComparison();
}
function resetImageView(){
 if(!sourceWidth)return;
 clearImageGesture();navigation.fit=true;navigation.centerX=navigation.centerY=.5;
 fitImage();announceNavigation();
}
function setImageZoom(scale,clientX=null,clientY=null){
 if(!ready||working||exporting||!Number.isFinite(scale))return;
 const m=imageMetrics();if(!m)return;
 const x=clientX??m.clientLeft+m.width/2,y=clientY??m.clientTop+m.height/2;
 const anchor=navigationPoint(x,y),next=clamp(scale,m.min,MAX_IMAGE_ZOOM);
 if(Math.abs(next-navigation.scale)<1e-10)return;
 navigation.fit=false;navigation.scale=next;
 navigation.centerX=anchor.x-(x-m.clientLeft-m.width/2)/(sourceWidth*next);
 navigation.centerY=anchor.y-(y-m.clientTop-m.height/2)/(sourceHeight*next);
 fitImage();announceNavigation();
}
function stepImageZoom(direction){
 const m=imageMetrics();if(!m)return;
 const stops=[m.min,m.fit,.25,.5,.75,1,1.5,2,3,4].filter(v=>v>=m.min&&v<=MAX_IMAGE_ZOOM).sort((a,b)=>a-b);
 const next=direction>0?stops.find(v=>v>navigation.scale+.00001):stops.slice().reverse().find(v=>v<navigation.scale-.00001);
 if(next===undefined)return;
 if(Math.abs(next-m.fit)<1e-8){navigation.fit=true;navigation.centerX=navigation.centerY=.5;fitImage();announceNavigation();}
 else setImageZoom(next);
}
function announceNavigation(){
 clearTimeout(navigationAnnounceTimer);
 navigationAnnounceTimer=setTimeout(()=>{$('zoomAnnouncement').textContent=(navigation.fit?'Fit, ':'')+zoomPercent(navigation.scale)+' canvas zoom';},180);
}
function syncNavigation(){
 const m=imageMetrics(),locked=!ready||working||exporting;
 const select=$('zoomSelect'),percent=zoomPercent(navigation.scale),label=navigation.fit?'Fit · '+percent:percent;
 const custom=$('zoomCustom');custom.hidden=true;
 const exact=[.25,.5,1,1.5,2,3,4].find(v=>Math.abs(v-navigation.scale)<.000001);
 if(navigation.fit)select.value='fit';else if(exact!==undefined)select.value=String(exact);
 else {custom.hidden=false;custom.textContent=percent;select.value='custom';}
 select.options[0].textContent=m?'Fit · '+zoomPercent(m.fit):'Fit';
 select.setAttribute('aria-label','Canvas zoom: '+label+'. 100% uses source pixel size. Maximum 400%.');
 select.disabled=locked;$('zoomInBtn').disabled=locked||navigation.scale>=MAX_IMAGE_ZOOM-1e-8;
 $('zoomOutBtn').disabled=locked||!m||navigation.scale<=m.min+1e-8;
 $('zoomFitBtn').disabled=locked;$('zoomFitBtn').dataset.fit=String(navigation.fit);
 $('panBtn').disabled=locked;$('panBtn').setAttribute('aria-pressed',String(navigation.hand));
 $('previewScale').textContent=label;
 const panning=Boolean(imageGesture&&(imageGesture.kind==='pan'||imageGesture.kind==='pinch'));
 const hand=navigation.space||(navigation.hand&&!picking)||panning;
 $('imageWindow').dataset.pan=String(hand);$('imageWindow').dataset.dragging=String(panning);
 const isDetail=detailIndexForView()>=0&&!picking&&!holdSource;
 $('imageFrame').style.cursor=hand?(panning?'grabbing':'grab'):isDetail?'default':'crosshair';
 $('zoomHelp').textContent=navigation.hand?'Pan tool on · drag to move · H to pick':'Scroll to zoom · Space + drag to pan';
 if(hand)$('canvasHint').textContent='Drag to pan · scroll or pinch to zoom.';
}
function toggleHand(){
 if(!ready||working||exporting)return;
 navigation.hand=!navigation.hand;
 if(navigation.hand)picking=false;
 updateView();
}
function visibleImageSpan(){
 if(!imageLayout)return null;
 const m=imageLayout,left=Math.max(0,m.imageLeft),right=Math.min(m.width,m.imageLeft+m.imageWidth);
 const top=Math.max(0,m.imageTop),bottom=Math.min(m.height,m.imageTop+m.imageHeight);
 return {left,right,top,bottom};
}
function layoutComparison(){
 if(!imageLayout)return;
 const actual=picking||holdSource?'source':view,span=visibleImageSpan(),m=imageLayout;
 if(actual!=='compare')return;
 // The divider tracks the visible part of the image, remaining usable at 400%.
 const x=span.left+(span.right-span.left)*split/100,cut=clamp((x-m.imageLeft)/m.imageWidth*100,0,100);
 sourceCanvas.style.clipPath=depthCanvas.style.clipPath=`inset(0 ${100-cut}% 0 0)`;
 outputCanvas.style.clipPath=`inset(0 0 0 ${cut}%)`;
 const handle=$('compareHandle');handle.style.left=(x-m.imageLeft)+'px';
 handle.querySelector('span').style.top=((span.top+span.bottom)/2-m.imageTop)+'px';
 handle.setAttribute('aria-valuenow',Math.round(split));
}
function moveComparison(clientX){
 const m=imageLayout,span=visibleImageSpan();if(!m||!span||span.right<=span.left)return;
 split=clamp((clientX-m.clientLeft-span.left)/(span.right-span.left)*100,0,100);layoutComparison();
}

function updateView(){
 const requestedDetail=detailIndexForView();
 if(requestedDetail>=0&&!detailLayers[requestedDetail].image)view='focus';
 const actual=picking||holdSource?'source':view,detailIndex=detailIndexForView(actual),isDetail=detailIndex>=0;
 const extraDepth=usesDepthCanvas(),showDepth=actual==='source'||actual==='compare';
 sourceCanvas.hidden=!showDepth||extraDepth;
 depthCanvas.hidden=!showDepth||!extraDepth;
 depthCanvas.style.clipPath=actual==='compare'?`inset(0 ${100-split}% 0 0)`:'none';
 if(showDepth&&extraDepth)paintDepthPreview();
 sourceCanvas.style.clipPath=actual==='compare'?`inset(0 ${100-split}% 0 0)`:'none';
 outputCanvas.hidden=actual==='source'||isDetail;
 detailCanvas.hidden=!isDetail;
 if(isDetail)paintDetailPreview(detailIndex);
 outputCanvas.style.clipPath=actual==='compare'?`inset(0 0 0 ${split}%)`:'none';
 $('compareHandle').hidden=actual!=='compare';$('compareHandle').style.left=split+'%';$('compareHandle').setAttribute('aria-valuenow',Math.round(split));
 $('sourceLabel').hidden=actual!=='source'&&actual!=='compare';
 $('sourceLabel').textContent=currentDepthPreview()==='two'?'Map 2 · source':currentDepthPreview()==='mixed'&&depthMixActive()?'Depth mix · '+(100-secondaryDepth.settings.weight)+' / '+secondaryDepth.settings.weight:'Map 1 · source';
 $('focusLabel').hidden=actual!=='focus'&&actual!=='compare';
 $('detailLabel').hidden=!isDetail;
 if(isDetail)$('detailLabel').textContent='Detail '+(detailIndex+1)+' · grayscale';
 const count=detailLayers.filter(l=>l.image&&l.settings.enabled&&l.settings.opacity>0).length;
 $('focusLabel').textContent=(params.secondEnabled?'Focus A + B':'Focus A')+(count?' · '+count+' detail'+(count>1?'s':''):'');
 document.querySelectorAll('[data-view]').forEach(b=>setAttr(b,'aria-pressed',b.dataset.view===view));
 setAttr($('pickBtn'),'aria-pressed',picking&&activeFocus===1);
 setAttr($('pickBtnB'),'aria-pressed',picking&&activeFocus===2);
 $('activeTarget').textContent=isDetail?'Grayscale':(picking?'Pick ':'Editing ')+focusLetter();
 $('activeTarget').style.color=activeFocus===2?'var(--focus-b)':'var(--focus-a)';
 $('imageFrame').style.cursor=isDetail?'default':'crosshair';
 $('imageFrame').setAttribute('aria-label',isDetail?'Aligned grayscale detail layer '+(detailIndex+1)+'. Use Focus to return to editing.':'Depth map preview. Click or drag to pick focus '+focusLetter()+'. Arrow keys move the active focus.');
 $('canvasHint').innerHTML=isDetail
  ?'Detail '+(detailIndex+1)+' · '+({stretch:'matched to frame',cover:'centre cropped',contain:'fitted without cropping'}[detailLayers[detailIndex].settings.fit])+'.'
  :picking?'Picking '+focusLetter()+' · tap the '+(depthMixActive()?'mixed depth.':'depth map.')+'<span class="desktop-hint"> <kbd>Esc</kbd> cancels.</span>'
  :'Editing '+focusLetter()+' · tap image to move focus.<span class="desktop-hint"> Hold <kbd>S</kbd> for depth'+(detailLayers[activeDetail].image?'; <kbd>D</kbd> toggles Detail '+(activeDetail+1):'')+'.</span>';
 if(planeActive()&&!isDetail){
  $('canvasHint').textContent=picking?'Tap a subject to place pivot '+focusLetter()+'.':'Tap image to place pivot '+focusLetter()+'.';
  $('focusLabel').textContent=(params.secondEnabled?'Planes A + B':'Plane A')+(count?' · '+count+' detail'+(count>1?'s':''):'');
  $('imageFrame').setAttribute('aria-label','Pick a pivot for 3D plane '+focusLetter()+'. Tap a subject or drag its labeled pivot.');
 }
 if(isDetail)$('pickRing').style.display='none';
 syncPins();syncNavigation();layoutComparison();
}

let previewBuffer=null;
const previewScheduler=createPreviewScheduler({
 frame:callback=>requestAnimationFrame(callback),
 sync(){updateDepthMix();syncControls();updateView();},
 ready:()=>ready&&!working,
 epoch:()=>previewEpoch,
 render(){
  const buffer=previewBuffer;previewBuffer=null;
  const outputBuffer=buffer?.byteLength===previewWidth*previewHeight*4?buffer:null;
  return engine.request('render',{params:snapshotParams(),details:detailSettingsSnapshot(),depthMix:depthMixSnapshot(),outputBuffer},outputBuffer?[outputBuffer]:[]);
 },
 paint(result){outputCtx.putImageData(new ImageData(new Uint8ClampedArray(result.buffer),previewWidth,previewHeight),0,0);previewBuffer=result.buffer;$('renderStatus').textContent='Live preview';},
 error:error=>toast(error.message,true)
});
function queueRender(){version++;previewScheduler.request();}
function showRing(x,y){clearTimeout(ringTimer);$('pickRing').style.left=(x*100)+'%';$('pickRing').style.top=(y*100)+'%';$('pickRing').style.display='block';ringTimer=setTimeout(()=>$('pickRing').style.display='none',1100);}
function pickAt(event,finish=false){
 if(!ready||working||exporting||(detailIndexForView()>=0&&!picking&&!holdSource))return;
 const rect=$('imageFrame').getBoundingClientRect();if(rect.width<=0||rect.height<=0)return;
 const nx=clamp((event.clientX-rect.left)/rect.width,0,1),ny=clamp((event.clientY-rect.top)/rect.height,0,1),x=Math.min(previewWidth-1,Math.floor(nx*previewWidth)),y=Math.min(previewHeight-1,Math.floor(ny*previewHeight)),value=depthValues[y*previewWidth+x];
 if(value===local.INVALID){if(finish)toast('This pixel is transparent or has no reliable hue. Pick a valid depth area.',true);return;}
 const px=(x+.5)/previewWidth,py=(y+.5)/previewHeight;
 if(planeActive()){
  const plane=params.planes[activeFocus-1];plane.pivot={x:px,y:py,depth:value/local.LAST*100};plane.slide=0;
  params[focusKey('center')]=plane.pivot.depth;pickedPoints[activeFocus]=null;
 }else{
  setPlaneCenter(clamp(Math.round(value/local.LAST*1000)/10,0,100));
  params.planes[activeFocus-1].pivot.x=px;params.planes[activeFocus-1].pivot.y=py;
  pickedPoints[activeFocus]={x:px,y:py};
 }
 showRing(px,py);touchSettings();
 if(finish&&picking){picking=false;view='focus';updateView();}
}
async function decodeImage(fileOrURL){
 if(typeof fileOrURL==='string')return new Promise((resolve,reject)=>{const image=new Image();image.onload=()=>resolve(image);image.onerror=()=>reject(new Error('The image could not be decoded.'));image.src=fileOrURL;});
 // Use the same image-element decoding path for embedded examples and uploads,
 // so identical inputs also use the same canvas resampling path.
 const url=URL.createObjectURL(fileOrURL);try{return await decodeImage(url);}finally{URL.revokeObjectURL(url);}
}
async function preparePreview(){
 const pixels=sourceCtx.getImageData(0,0,previewWidth,previewHeight);
 primaryAlpha=new Uint8Array(previewWidth*previewHeight);
 for(let p=0;p<primaryAlpha.length;p++)primaryAlpha[p]=pixels.data[p*4+3];
 const result=await engine.request('prepare',{buffer:pixels.data.buffer,encoding,width:previewWidth,height:previewHeight},[pixels.data.buffer]);
 resolvedMode=result.mode;histogram=result.histogram;primaryDepthValues=new Uint16Array(result.values);depthValues=primaryDepthValues;depthMixDirty=true;depthPaintKey='';
 $('encodingStatus').textContent=(encoding==='auto'?'Detected: ':'Using: ')+labels[resolvedMode]+(resolvedMode==='spectral'?' · approximate palette values':'');
 await prepareDepth2Preview();updateDepthMix();
 await prepareDetailPreview();
 syncControls();
 const rendered=await engine.request('render',{params:snapshotParams(),details:detailSettingsSnapshot(),depthMix:depthMixSnapshot()});
 outputCtx.putImageData(new ImageData(new Uint8ClampedArray(rendered.buffer),previewWidth,previewHeight),0,0);
}
async function loadImage(input,name,isExample=false){
 if(working||exporting)return;
 try{validateImageFile(input);}catch(error){toast(error.message,true);return;}
 const previous={image:sourceImage,width:sourceWidth,height:sourceHeight,name:sourceName,params:snapshotParams(),encoding,activeFocus,view,pickedPoints,details:detailSettingsSnapshot(),preset:activePreset,depthSettings:{...secondaryDepth.settings},depthPreview};
 setBusy(true,isExample?'Opening the example depth map…':'Reading your depth map…');
 ready=false;version++;loadToken++;let decoded=null;
 try{
  decoded=await decodeImage(input);const {w,h}=validateImageSize(decoded);
  if(isExample){params=makeParams();encoding='auto';activePreset='sculpted';activeFocus=1;view='focus';detailLayers.forEach(l=>l.settings={...detailDefaults});}
  else detailLayers.forEach(l=>l.settings.enabled=false); // A different scene must not inherit an active texture silently.
  secondaryDepth.settings=isExample?{...depthMixDefaults}:{...secondaryDepth.settings,enabled:false};depthPreview='mixed';
  resetPlanesForImage();
  pickedPoints={1:null,2:null};sourceWidth=w;sourceHeight=h;sourceName=name||'depth-map.png';
  const scale=Math.min(1,1500/Math.max(w,h));previewWidth=Math.max(1,Math.round(w*scale));previewHeight=Math.max(1,Math.round(h*scale));
  sourceCanvas.width=outputCanvas.width=previewWidth;sourceCanvas.height=outputCanvas.height=previewHeight;
  drawDetailTo(sourceCtx,decoded,previewWidth,previewHeight,'stretch');
  await preparePreview();sourceImage=decoded;
  if(previous.image&&previous.image!==decoded&&previous.image.close)previous.image.close();decoded=null;
  $('fileName').textContent=isExample?'Built-in example':sourceName;$('fileName').title=sourceName;
  $('imageDimensions').textContent=w.toLocaleString()+' × '+h.toLocaleString();$('previewScale').textContent='FIT';
  ready=true;picking=false;holdSource=false;view='focus';resetImageView();updateView();
  if(!isExample)toast('Depth ready · '+labels[resolvedMode]+(secondaryDepth.image||detailLayers.some(l=>l.image)?'. Map 2 and loaded detail layers paused; replace or re-enable them.':'. Tap a colour to choose focus.'));
  return true;
 }catch(error){
  if(decoded&&decoded.close)decoded.close();
  sourceImage=previous.image;sourceWidth=previous.width;sourceHeight=previous.height;sourceName=previous.name;
  params=previous.params;encoding=previous.encoding;activeFocus=previous.activeFocus;view=previous.view;
  pickedPoints=previous.pickedPoints;detailLayers.forEach((l,i)=>l.settings=previous.details[i]);activePreset=previous.preset;secondaryDepth.settings=previous.depthSettings;depthPreview=previous.depthPreview;
  if(sourceImage){
   const scale=Math.min(1,1500/Math.max(sourceWidth,sourceHeight));previewWidth=Math.max(1,Math.round(sourceWidth*scale));previewHeight=Math.max(1,Math.round(sourceHeight*scale));
   sourceCanvas.width=outputCanvas.width=previewWidth;sourceCanvas.height=outputCanvas.height=previewHeight;
   drawDetailTo(sourceCtx,sourceImage,previewWidth,previewHeight,'stretch');
   try{await preparePreview();ready=true;fitImage();}catch(_){ready=false;}
  }
  toast(error.message||'Unable to open this image. Try PNG, JPEG or WebP.',true);return false;
 }finally{setBusy(false);if(ready)queueRender();}
}
async function loadExamplePair(){
 if(working||exporting)return;
 if($('settingsDialog').open)$('settingsDialog').close();
 if($('detailDialog').open)$('detailDialog').close();
 if($('depthDialog').open)$('depthDialog').close();
 const loaded=await loadImage(EXAMPLE,'depth-map-example.jpg',true);
 if(!loaded)return;
 // Reloading the example restores a known single-depth, one-detail starting point.
 await removeDepth2();secondaryDepth.settings={...depthMixDefaults};
 await removeDetail(1);
 detailLayers[1].settings={...detailDefaults};activeDetail=0;
 await loadDetailImage(DETAIL_EXAMPLE,'normal-map-example.jpg',true,0);
 toast('Example ready · Detail 1 is the normal map. Detail 2 is empty.');
}
async function changeEncoding(){
 if(!ready||working||exporting)return;version++;loadToken++;pickedPoints={1:null,2:null};setBusy(true,'Reading the map values…');
 try{await preparePreview();ready=true;}catch(error){toast(error.message,true);}finally{setBusy(false);queueRender();}
}
function downloadBlob(blob,name){const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),30000);}
async function exportPNG(){
 if(!ready||working||exporting)return;
 exporting=true;setBusy(true,'Preparing full-resolution export…');$('exportText').textContent='Exporting…';
 const settings=snapshotParams(),textureSettings=detailSettingsSnapshot(),mode=resolvedMode;
 const depthSettings=depthMixSnapshot(),depth2Image=secondaryDepth.image,depth2Mode=secondaryDepth.mode;
 const useDepth2=Boolean(depth2Image&&depthSettings.enabled&&depthSettings.weight>0);
 const images=detailLayers.map(l=>l.image);
 const enabled=images.map((image,i)=>Boolean(image&&textureSettings[i].enabled&&textureSettings[i].opacity>0));
 const count=enabled.filter(Boolean).length;
 // Only the output is a full-size canvas. This one texture canvas is reused
 // for both layers, strip by strip, rather than allocating two full-size layers.
 const canvas=document.createElement('canvas'),textureCanvas=document.createElement('canvas');
 try{
  canvas.width=sourceWidth;canvas.height=sourceHeight;
  const ctx=canvas.getContext('2d',{willReadFrequently:true});
  if(!ctx)throw new Error('Not enough browser memory to export this image. Try a smaller depth image.');
  ctx.drawImage(sourceImage,0,0);
  const rows=Math.max(1,Math.min(512,Math.floor(2000000/(sourceWidth*(1+count+(useDepth2?1:0))))));
  let textureCtx=null;
  if(count||useDepth2){textureCanvas.width=sourceWidth;textureCanvas.height=rows;textureCtx=textureCanvas.getContext('2d',{willReadFrequently:true});if(!textureCtx)throw new Error('Not enough browser memory for detail processing.');}
  for(let y=0;y<sourceHeight;y+=rows){
   const h=Math.min(rows,sourceHeight-y),strip=ctx.getImageData(0,y,sourceWidth,h);
   const detailBuffers=[null,null],transfers=[strip.data.buffer];
   let depth2Buffer=null;
   if(useDepth2){
    drawDetailTo(textureCtx,depth2Image,sourceWidth,sourceHeight,depthSettings.fit,y,rows);
    depth2Buffer=textureCtx.getImageData(0,0,sourceWidth,h).data.buffer;transfers.push(depth2Buffer);
   }
   for(let i=0;i<2;i++)if(enabled[i]){
    drawDetailTo(textureCtx,images[i],sourceWidth,sourceHeight,textureSettings[i].fit,y,rows);
    detailBuffers[i]=textureCtx.getImageData(0,0,sourceWidth,h).data.buffer;
    transfers.push(detailBuffers[i]);
   }
   const result=await engine.request('exportStrip',{buffer:strip.data.buffer,params:settings,mode,width:sourceWidth,height:sourceHeight,offsetY:y,detailBuffers,details:textureSettings,depth2Buffer,depth2Mode,depthMix:depthSettings},transfers);
   ctx.putImageData(new ImageData(new Uint8ClampedArray(result.buffer),sourceWidth,h),0,y);
   $('busyText').textContent='Rendering original size · '+Math.round((y+h)/sourceHeight*100)+'%';
   await new Promise(resolve=>setTimeout(resolve,0));
  }
  $('busyText').textContent='Encoding PNG…';
  const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));
  if(!blob)throw new Error('PNG encoding failed. This browser may need a smaller depth image.');
  const base=sourceName.replace(/\.[^.]+$/,'').replace(/[^a-zA-Z0-9_\-\u00C0-\u024F ]/g,'_')||'depth-map';
  downloadBlob(blob,base+(settings.advanced&&mode!=='hue'?'-3d-plane':'')+(useDepth2?'-mixed':'')+(count===2?'-focus-2-details':count===1?'-focus-detail':'-focus')+'.png');
  toast('PNG exported · '+sourceWidth.toLocaleString()+' × '+sourceHeight.toLocaleString()+' pixels'+(useDepth2?' · depth mix included':'')+(count?' · '+count+' detail layer'+(count===2?'s':'')+' included.':'.'));
 }catch(error){toast(error.message||'Export failed. Try a smaller depth image.',true);}
 finally{canvas.width=canvas.height=textureCanvas.width=textureCanvas.height=1;exporting=false;$('exportText').textContent='Export PNG';setBusy(false);queueRender();}
}
async function resetControls(){
 if(working||exporting)return;
 const changed=detailLayers.some(l=>l.image&&l.settings.fit!==detailDefaults.fit);
 const depthChanged=secondaryDepth.image&&(secondaryDepth.settings.fit!==depthMixDefaults.fit||secondaryDepth.settings.encoding!==depthMixDefaults.encoding);
 secondaryDepth.settings={...depthMixDefaults,enabled:Boolean(secondaryDepth.image)};depthPreview='mixed';depthMixDirty=true;
 params=makeParams();detailLayers.forEach(l=>l.settings={...detailDefaults,enabled:Boolean(l.image)});
 activePreset='sculpted';activeFocus=1;activeDetail=0;pickedPoints={1:null,2:null};picking=false;
 $('settingsDialog').close();updateView();
 if(depthChanged)await refreshDepth2Preview();
 if(changed)await refreshDetailPreview();else queueRender();
 toast('Depth blend, focus, tone and detail controls reset. Loaded images kept.');
}
function saveLook(){
 const recipe={app:'depth-focus',version:10,encoding,activeFocus,activeDetail,frame:{width:sourceWidth,height:sourceHeight},parameters:snapshotParams(),depthMix:{...secondaryDepth.settings,image:secondaryDepth.image?{name:secondaryDepth.name,width:secondaryDepth.width,height:secondaryDepth.height}:null},details:detailLayers.map(l=>({...l.settings,image:l.image?{name:l.name,width:l.width,height:l.height}:null})),note:'Settings only; no images or preview zoom/pan. 3D plane pivots, angles and normal offsets are included. Load matching maps into Map 1 and Map 2 and matching textures into Detail 1 and Detail 2. Decode and average depth, apply flat or 3D-plane focus, then Detail 1, then Detail 2.'};
 downloadBlob(new Blob([JSON.stringify(recipe,null,2)],{type:'application/json'}),'depth-focus-look-v10.json');
 toast('Look saved. Images are not included.');
}
function validateLook(data){
 if(!data||data.app!=='depth-focus'||![1,2,3,4,5,6,7,8,9,10].includes(data.version)||!data.parameters||typeof data.parameters!=='object')throw new Error('This is not a supported Depth / Focus look file.');
 const p=data.parameters,next=makeParams(),keys=data.version===1?firstVersionControls:controls;
 for(const key of keys){
  const value=p[key],input=$(key);
  if(typeof value!=='number'||!Number.isFinite(value)||value<Number(input.min)||value>Number(input.max))throw new Error('The look contains an invalid '+key+' value.');
  next[key]=value;
 }
 if(!['band','ramp','mask'].includes(p.profile))throw new Error('The tone profile is not supported.');
 if(typeof p.invert!=='boolean'||typeof p.reverse!=='boolean')throw new Error('The look contains invalid switch settings.');
 if(data.version>=2&&typeof p.secondEnabled!=='boolean')throw new Error('The second focus setting is invalid.');
 if(!['auto','spectral','hue','gray'].includes(data.encoding))throw new Error('The map encoding is not supported.');
 next.profile=p.profile;next.invert=p.invert;next.reverse=p.reverse;
 next.secondEnabled=data.version>=2?p.secondEnabled:false;
 next.planes=[makePlane(next.center),makePlane(next.center2)];
 let migration='';
 function finite(v,lo,hi,label){if(typeof v!=='number'||!Number.isFinite(v)||v<lo||v>hi)throw new Error('Invalid '+label+' in the look.');return v;}
 if(data.version>=8){
  if(typeof p.advanced!=='boolean'||!Array.isArray(p.planes)||p.planes.length!==2)throw new Error('Invalid 3D plane settings.');
  next.advanced=p.advanced;
  next.planes=p.planes.map(pl=>{
   if(!pl||typeof pl.enabled!=='boolean'||!pl.pivot)throw new Error('Invalid plane or pivot.');
   return {enabled:pl.enabled,yaw:finite(pl.yaw,-180,180,'left/right angle'),pitch:finite(pl.pitch,-90,90,'up/down angle'),slide:finite(pl.slide,-100,100,'slide'),pivot:{x:finite(pl.pivot.x,0,1,'pivot X'),y:finite(pl.pivot.y,0,1,'pivot Y'),depth:finite(pl.pivot.depth,0,100,'pivot depth')}};
  });
 }else if(data.version===7){
  // v7 existed in a global depth-offset variant and a two-anchor variant.
  // Both can be represented as planes, but their old clipped-depth behavior
  // is not reproduced. Perpendicular widths are scaled to retain band shape.
  const aspect=frameAspect(),sx=aspect>=1?1:aspect,sy=aspect>=1?1/aspect:1;
  function fromGradient(index,gx,gy,pivot){
   const normal=vec.unit([-gx/sx,gy/sy,1]),plane=makePlane(pivot.depth);
   Object.assign(plane,normalToAngles(normal));plane.pivot=pivot;
   next.planes[index]=plane;next[index===0?'center':'center2']=pivot.depth;
   const widthKey=index===0?'width':'width2';next[widthKey]=clamp(next[widthKey]*normal[2],.5,100);
  }
  if(Array.isArray(p.planes)&&p.planes.length===2&&typeof p.advanced==='boolean'){
   next.advanced=p.advanced;
   p.planes.forEach((pl,index)=>{
    if(!pl||typeof pl.enabled!=='boolean'||!Array.isArray(pl.points)||pl.points.length!==2)throw new Error('Invalid v7 anchor data.');
    const pts=pl.points.map(pt=>({x:finite(pt.x,0,1,'anchor X'),y:finite(pt.y,0,1,'anchor Y'),depth:finite(pt.depth,0,100,'anchor depth')}));
    if(!p.advanced||!pl.enabled)return;
    const [a,b]=pts,dx=(b.x-a.x)*sx,dy=(b.y-a.y)*sy,l2=dx*dx+dy*dy;
    if(l2<1e-10)return;
    const diff=(b.depth-a.depth)/100;
    fromGradient(index,diff*dx*sx/l2,diff*dy*sy/l2,{x:(a.x+b.x)/2,y:(a.y+b.y)/2,depth:(a.depth+b.depth)/2});
   });
   migration='v7 look converted to 3D planes using the loaded image’s aspect ratio. Check thickness and framing.';
  }else if(typeof p.rotateEnabled==='boolean'){
   const amount=finite(p.rotateAmount,-100,100,'rotation amount')/100,angle=finite(p.rotateAngle,-180,180,'rotation direction')*Math.PI/180;
   next.advanced=p.rotateEnabled;
   if(next.advanced)for(let i=0;i<2;i++)fromGradient(i,-amount*Math.cos(angle),-amount*Math.sin(angle),{x:.5,y:.5,depth:i===0?next.center:next.center2});
   migration='Old offset look converted to 3D planes. Clipped endpoint artifacts are not retained; check the result.';
  }else throw new Error('Unrecognized v7 plane settings.');
 }

 const details=[{...detailDefaults},{...detailDefaults}];
 function readDetail(d){
  if(!d||typeof d.enabled!=='boolean'||typeof d.opacity!=='number'||!Number.isFinite(d.opacity)||d.opacity<0||d.opacity>100||!['multiply','overlay'].includes(d.blend)||!['stretch','cover','contain'].includes(d.fit))throw new Error('The look contains invalid detail settings.');
  return {enabled:d.enabled,opacity:d.opacity,blend:d.blend,fit:d.fit};
 }
 if(data.version>=5){
  if(!Array.isArray(data.details)||data.details.length!==2)throw new Error('This look must contain two detail slots.');
  details[0]=readDetail(data.details[0]);details[1]=readDetail(data.details[1]);
 }else if(data.version>=3)details[0]=readDetail(data.detail);
 let depthMix={...depthMixDefaults};
 if(data.version>=6){
  const d=data.depthMix;
  if(!d||typeof d.enabled!=='boolean'||typeof d.reverse!=='boolean'||typeof d.weight!=='number'||!Number.isFinite(d.weight)||d.weight<0||d.weight>100||!['auto','spectral','gray'].includes(d.encoding)||!['stretch','cover','contain'].includes(d.fit))throw new Error('The look contains invalid depth mix settings.');
  depthMix={enabled:d.enabled,weight:d.weight,encoding:d.encoding,fit:d.fit,reverse:d.reverse};
 }
 return {params:next,details,depthMix,migration,encoding:data.encoding,activeFocus:data.activeFocus===2&&next.secondEnabled?2:1,activeDetail:data.version>=5&&data.activeDetail===1?1:0,version:data.version};
}

// Standard controls and import/export actions.
for(const key of controls)$(key).addEventListener('input',()=>{
 if(working||exporting){syncControls();return;}
 if(['center','width','softness'].includes(key))activeFocus=1;
 if(['center2','width2','softness2'].includes(key))activeFocus=2;
 params[key]=Number($(key).value);
 if(key==='center'||key==='center2')setPlaneCenter(params[key],activeFocus);
 touchSettings();
});
$('secondEnabled').addEventListener('change',()=>{
 if(working||exporting){syncControls();return;}
 params.secondEnabled=$('secondEnabled').checked;
 if(params.secondEnabled)activeFocus=2;
 else if(activeFocus===2){activeFocus=1;picking=false;}
 updateView();touchSettings();
});
$('focusSelectA').addEventListener('click',()=>selectFocus(1));
$('focusSelectB').addEventListener('click',()=>selectFocus(2,true));
$('pickBtnB').addEventListener('click',()=>togglePicker(2));
$('profile').addEventListener('change',()=>{params.profile=$('profile').value;touchSettings();});
for(const key of ['invert','reverse'])$(key).addEventListener('change',()=>{params[key]=$(key).checked;touchSettings();});
$('encoding').addEventListener('change',()=>{encoding=$('encoding').value;changeEncoding();});
$('pickBtn').addEventListener('click',()=>togglePicker(1));
$('openBtn').addEventListener('click',()=>$('fileInput').click());
$('fileInput').addEventListener('change',event=>{const file=event.target.files[0];if(file)loadImage(file,file.name);event.target.value='';});
$('exampleBtn').addEventListener('click',loadExamplePair);
$('exportBtn').addEventListener('click',exportPNG);$('resetBtn').addEventListener('click',resetControls);
$('saveLookBtn').addEventListener('click',saveLook);$('loadLookBtn').addEventListener('click',()=>$('lookInput').click());
$('lookInput').addEventListener('change',async event=>{
 const file=event.target.files[0];event.target.value='';if(!file||working||exporting)return;
 try{
  if(file.size>50000)throw new Error('This look file is unexpectedly large.');
  const look=validateLook(JSON.parse(await file.text()));
  if(working||exporting)return;
  const changed=look.encoding!==encoding,realign=look.details.some((d,i)=>detailLayers[i].image&&d.fit!==detailLayers[i].settings.fit);
  const depthChanged=secondaryDepth.image&&(look.depthMix.encoding!==secondaryDepth.settings.encoding||look.depthMix.fit!==secondaryDepth.settings.fit);
  secondaryDepth.settings=look.depthMix;depthMixDirty=true;depthPreview='mixed';
  params=look.params;detailLayers.forEach((l,i)=>l.settings=look.details[i]);activeDetail=look.activeDetail;activeFocus=look.activeFocus;pickedPoints={1:null,2:null};picking=false;
  encoding=look.encoding;activePreset='';$('settingsDialog').close();updateView();syncControls();
  if(changed&&ready)await changeEncoding();
  else {if(depthChanged&&ready)await refreshDepth2Preview();if(realign&&ready)await refreshDetailPreview();else queueRender();}
  toast(look.migration|| (look.version<6?'Earlier look restored · Map 2 bypassed; matching detail settings restored.':secondaryDepth.settings.enabled&&!secondaryDepth.image||detailLayers.some(l=>l.settings.enabled&&!l.image)?'Look restored. Load the missing matching images separately.':'Look restored. Focus-plane, depth and detail settings apply to the loaded images.')); 
 }catch(error){toast(error.message||'Unable to read this look file.',true);}
});
const looks={sculpted:{width:18,softness:94,contrast:1.2,lift:1,background:0,profile:'band'},soft:{width:32,softness:100,contrast:.75,lift:1.2,background:0,profile:'band'},graphic:{width:12,softness:20,contrast:2.6,lift:1,background:0,profile:'band'}};
document.querySelectorAll('[data-preset]').forEach(button=>button.addEventListener('click',()=>{
 if(working||exporting)return;
 const preset=looks[button.dataset.preset],{width,softness,...shared}=preset;
 params={...params,...shared,[focusKey('width')]:width,[focusKey('softness')]:softness};
 activePreset=button.dataset.preset;$('settingsDialog').close();updateView();queueRender();
}));
document.querySelectorAll('[data-view]').forEach(button=>button.addEventListener('click',()=>{if(working||exporting)return;view=button.dataset.view;const index=detailIndexForView();if(index>=0)activeDetail=index;picking=false;holdSource=false;syncDetailControls();updateView();}));
$('settingsBtn').addEventListener('click',()=>$('settingsDialog').showModal());
for(const id of ['closeSettings','settingsDone'])$(id).addEventListener('click',()=>$('settingsDialog').close());
$('settingsDialog').addEventListener('click',event=>{const r=$('settingsDialog').getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)$('settingsDialog').close();});
$('helpBtn').addEventListener('click',()=>{$('settingsDialog').close();$('helpDialog').showModal();});
$('closeHelp').addEventListener('click',()=>$('helpDialog').close());
$('helpDialog').addEventListener('click',event=>{const r=$('helpDialog').getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)$('helpDialog').close();});

// A second depth input is independent of the two downstream detail slots.
$('loadDepth1Btn').addEventListener('click',()=>$('fileInput').click());
$('loadDepth1DialogBtn').addEventListener('click',()=>{$('depthDialog').close();$('fileInput').click();});
for(const id of ['loadDepth2Btn','loadDepth2DialogBtn'])$(id).addEventListener('click',()=>{if(ready&&!working&&!exporting)$('depth2Input').click();});
$('depth2Input').addEventListener('change',event=>{const file=event.target.files[0];event.target.value='';if(file)loadDepth2Image(file,file.name);});
for(const id of ['depthOptionsBtn','depthSettingsLink'])$(id).addEventListener('click',openDepthOptions);
for(const id of ['closeDepth','depthDone'])$(id).addEventListener('click',()=>$('depthDialog').close());
$('depthDialog').addEventListener('click',event=>{const r=$('depthDialog').getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)$('depthDialog').close();});
$('depthWeight').addEventListener('input',()=>{if(working||exporting){syncDepthControls();return;}secondaryDepth.settings.weight=clamp(Number($('depthWeight').value),0,100);touchDepthMix();});
$('depth2Enabled').addEventListener('change',()=>{if(working||exporting){syncDepthControls();return;}secondaryDepth.settings.enabled=$('depth2Enabled').checked;touchDepthMix();});
$('depthHalfBtn').addEventListener('click',()=>{if(!secondaryDepth.image||working||exporting)return;secondaryDepth.settings.enabled=true;secondaryDepth.settings.weight=50;touchDepthMix();});
$('depth2Reverse').addEventListener('change',()=>{if(working||exporting){syncDepthControls();return;}secondaryDepth.settings.reverse=$('depth2Reverse').checked;touchDepthMix();});
$('depthPreviewSelect').addEventListener('change',()=>{depthPreview=$('depthPreviewSelect').value;view='source';picking=false;holdSource=false;depthPaintKey='';updateView();});
$('depth1Encoding').addEventListener('change',()=>{if(working||exporting){syncDepthControls();return;}encoding=$('depth1Encoding').value;changeEncoding();});
$('depth2Encoding').addEventListener('change',()=>{if(working||exporting){syncDepthControls();return;}secondaryDepth.settings.encoding=$('depth2Encoding').value;refreshDepth2Preview();});
$('depth2Fit').addEventListener('change',()=>{if(working||exporting){syncDepthControls();return;}secondaryDepth.settings.fit=$('depth2Fit').value;refreshDepth2Preview();});
$('removeDepth2Btn').addEventListener('click',removeDepth2);

// Independent local imports and controls for the two detail slots.
for(let index=0;index<2;index++){
 const id=stem=>detailId(stem,index);
 $(id('detailInput')).addEventListener('change',event=>{const file=event.target.files[0];event.target.value='';if(file)loadDetailImage(file,file.name,false,index);});
 $(id('loadDetailBtn')).addEventListener('click',()=>{if(!working&&!exporting&&ready){selectDetailLayer(index);$(id('detailInput')).click();}});
 $(id('detailOptionsBtn')).addEventListener('click',()=>openDetailOptions(index));
 $('detailSelect'+(index+1)).addEventListener('click',()=>selectDetailLayer(index));
 $(id('detailOpacity')).addEventListener('input',()=>{if(working||exporting){syncDetailControls();return;}activeDetail=index;detailLayers[index].settings.opacity=clamp(Number($(id('detailOpacity')).value),0,100);queueRender();});
 $(id('detailBlend')).addEventListener('change',()=>{if(working||exporting){syncDetailControls();return;}activeDetail=index;detailLayers[index].settings.blend=$(id('detailBlend')).value;queueRender();});
 $(id('detailEnabled')).addEventListener('change',()=>{if(working||exporting){syncDetailControls();return;}activeDetail=index;detailLayers[index].settings.enabled=$(id('detailEnabled')).checked;queueRender();});
}
$('loadDetailDialogBtn').addEventListener('click',()=>{if(!working&&!exporting&&ready)$(detailId('detailInput')).click();});
$('detailExampleBtn').addEventListener('click',()=>loadDetailImage(DETAIL_EXAMPLE,'normal-map-example.jpg',true,activeDetail));
$('detailSettingsLink').addEventListener('click',()=>openDetailOptions());
for(const id of ['closeDetail','detailDone'])$(id).addEventListener('click',()=>$('detailDialog').close());
$('detailDialog').addEventListener('click',event=>{const r=$('detailDialog').getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)$('detailDialog').close();});
document.querySelectorAll('[data-edit-detail]').forEach(button=>button.addEventListener('click',()=>selectDetailLayer(Number(button.dataset.editDetail))));
$('detailFit').addEventListener('change',()=>{if(working||exporting){syncDetailControls();return;}detailLayers[activeDetail].settings.fit=$('detailFit').value;syncDetailControls();refreshDetailPreview(activeDetail);});
$('removeDetailBtn').addEventListener('click',()=>removeDetail());
$('swapDetailsBtn').addEventListener('click',swapDetailLayers);
$('showDetailBtn').addEventListener('click',()=>{if(!detailLayers[activeDetail].image)return;view=detailViewName(activeDetail);picking=false;holdSource=false;$('detailDialog').close();updateView();});

// Rotation events are deliberately separate from the source-image picker.
$('advancedMode').addEventListener('change',()=>setAdvanced($('advancedMode').checked));
$('showGuides').addEventListener('change',()=>{showPlaneGuides=$('showGuides').checked;syncPlaneGuides();});
$('planeHelpBtn').addEventListener('click',()=>$('planeDialog').showModal());
for(const id of ['closePlaneHelp','planeHelpDone'])$(id).addEventListener('click',()=>$('planeDialog').close());
$('planeDialog').addEventListener('click',event=>{const r=$('planeDialog').getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)$('planeDialog').close();});
for(const [focus,L] of [[1,'A'],[2,'B']]){
 $('editPlane'+L).addEventListener('click',()=>{selectFocus(focus,true);syncPlaneControls();});
 $('planeSlide'+L).addEventListener('input',()=>{if(working||exporting){syncPlaneControls();return;}activeFocus=focus;params.planes[focus-1].slide=Number($('planeSlide'+L).value);touchSettings();});
 $('pivot'+L).addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();event.stopPropagation();togglePicker(focus);}});
}
for(const [key,id] of [['yaw','planeYaw'],['pitch','planePitch']])$(id).addEventListener('input',()=>{if(working||exporting||!planeActive()){syncPlaneControls();return;}params.planes[activeFocus-1][key]=Number($(id).value);touchSettings();});
function faceOn(){if(!planeActive()||working||exporting)return;params.planes[activeFocus-1].yaw=0;params.planes[activeFocus-1].pitch=0;touchSettings();}
$('faceOnBtn').addEventListener('click',faceOn);
$('sceneView').addEventListener('change',()=>{stopSceneDrag();queuePlaneDraw();});
$('planeCanvas').addEventListener('pointerdown',event=>{
 if(event.button!==0||!planeActive()||working||exporting)return;
 event.preventDefault();const canvas=$('planeCanvas'),rect=canvas.getBoundingClientRect(),camera=sceneCamera();
 sceneDrag={focus:activeFocus,rect,camera,start:toSceneVector(arcVector(event,rect),camera),normal:local.planeNormal(params.planes[activeFocus-1])};
 canvas.setPointerCapture(event.pointerId);canvas.dataset.dragging='true';canvas.focus({preventScroll:true});
});
$('planeCanvas').addEventListener('pointermove',event=>{
 if(!sceneDrag||working||exporting)return;event.preventDefault();
 const d=sceneDrag,current=toSceneVector(arcVector(event,d.rect),d.camera),cross=vec.cross(d.start,current),length=Math.hypot(...cross),dot=clamp(vec.dot(d.start,current),-1,1);
 if(length<1e-8)return;
 const normal=rotateVector(d.normal,vec.mul(cross,1/length),Math.atan2(length,dot));
 Object.assign(params.planes[d.focus-1],normalToAngles(normal));activeFocus=d.focus;touchSettings();
});
for(const event of ['pointerup','pointercancel','lostpointercapture'])$('planeCanvas').addEventListener(event,stopSceneDrag);
$('planeCanvas').addEventListener('dblclick',event=>{event.preventDefault();faceOn();});
$('planeCanvas').addEventListener('keydown',event=>{
 if(!planeActive()||working||exporting)return;const step=event.shiftKey?10:2,p=params.planes[activeFocus-1];
 if(event.key==='Home'){event.preventDefault();event.stopPropagation();faceOn();return;}
 if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key))return;
 event.preventDefault();event.stopPropagation();
 if(event.key==='ArrowLeft'||event.key==='ArrowRight')p.yaw=clamp(p.yaw+(event.key==='ArrowRight'?step:-step),-180,180);
 else p.pitch=clamp(p.pitch+(event.key==='ArrowDown'?step:-step),-90,90);
 touchSettings();
});
if(typeof ResizeObserver!=='undefined')new ResizeObserver(queuePlaneDraw).observe($('planeScene'));
else window.addEventListener('resize',queuePlaneDraw);
window.addEventListener('blur',stopSceneDrag);


// v9 image gestures. Touch taps commit on release, so the first finger of a
// pinch never changes focus. Pointer capture lets pans continue beyond the edge.
const imagePointers=new Map();
let imageGesture=null,draggingImage=false,draggingSplit=false;
function captureImagePointer(id){try{$('imageWindow').setPointerCapture(id);}catch(_){}}
function releaseImagePointer(id){try{if($('imageWindow').hasPointerCapture(id))$('imageWindow').releasePointerCapture(id);}catch(_){}}
function clearImageGesture(){
 const ids=[...imagePointers.keys()];imagePointers.clear();imageGesture=null;
 draggingImage=draggingSplit=false;for(const id of ids)releaseImagePointer(id);
 if($('imageWindow')){$('imageWindow').dataset.dragging='false';}
}
function gestureSnapshot(){return {params:snapshotParams(),pickedPoints:JSON.parse(JSON.stringify(pickedPoints)),activeFocus,picking,view,activePreset};}
function undoGesturePick(g){
 if(!g?.didPick||!g.before)return;
 params=g.before.params;pickedPoints=g.before.pickedPoints;activeFocus=g.before.activeFocus;
 picking=g.before.picking;view=g.before.view;activePreset=g.before.activePreset;queueRender();
}
function startImagePinch(){
 const points=[...imagePointers.values()];if(points.length<2)return;
 undoGesturePick(imageGesture);
 const a=points[0],b=points[1],x=(a.x+b.x)/2,y=(a.y+b.y)/2;
 imageGesture={kind:'pinch',distance:Math.max(1,Math.hypot(a.x-b.x,a.y-b.y)),scale:navigation.scale,anchor:navigationPoint(x,y)};
 draggingImage=draggingSplit=false;syncNavigation();
}
function beginGesturePick(g,event,finish=false){
 if(g.focus){activeFocus=g.focus;picking=false;}
 if(!g.before)g.before=gestureSnapshot();
 g.didPick=true;pickAt(event,finish);
}
function imagePointerDown(event){
 if(!ready||working||exporting||(event.button!==0&&event.button!==1))return;
 if(event.pointerType!=='touch'&&imagePointers.size)return;
 event.preventDefault();
 imagePointers.set(event.pointerId,{x:event.clientX,y:event.clientY,type:event.pointerType});captureImagePointer(event.pointerId);
 if(imagePointers.size>=2){startImagePinch();return;}
 const frame=$('imageFrame').getBoundingClientRect();
 const onImage=event.clientX>=frame.left&&event.clientX<=frame.right&&event.clientY>=frame.top&&event.clientY<=frame.bottom;
 const pivot=event.target.closest('[data-pivot-focus]'),divider=event.target.closest('#compareHandle');
 const hand=event.button===1||navigation.space||(navigation.hand&&!picking);
 let kind=hand||!onImage?'pan':divider?'split':event.pointerType==='touch'&&!pivot?'tap':'pick';
 imageGesture={kind,id:event.pointerId,startX:event.clientX,startY:event.clientY,startCenterX:navigation.centerX,startCenterY:navigation.centerY,scale:navigation.scale,focus:pivot?Number(pivot.dataset.pivotFocus):0,didPick:false};
 // Snapshot only a potential edit. Pinching or panning does not clone pixels.
 if(kind==='pick')imageGesture.before=gestureSnapshot();
 draggingImage=kind==='pick';draggingSplit=kind==='split';
 if(kind==='split')$('compareHandle').focus({preventScroll:true});
 else $('imageFrame').focus({preventScroll:true});
 syncNavigation();
}
function imagePointerMove(event){
 const pointer=imagePointers.get(event.pointerId);if(!pointer||!imageGesture)return;
 event.preventDefault();pointer.x=event.clientX;pointer.y=event.clientY;
 if(working||exporting){clearImageGesture();syncNavigation();return;}
 const g=imageGesture;
 if(g.kind==='pinch'){
  const points=[...imagePointers.values()];if(points.length<2)return;
  const a=points[0],b=points[1],x=(a.x+b.x)/2,y=(a.y+b.y)/2,m=imageMetrics();if(!m)return;
  const distance=Math.max(1,Math.hypot(a.x-b.x,a.y-b.y));
  const scale=clamp(g.scale*distance/g.distance,m.min,MAX_IMAGE_ZOOM);
  navigation.fit=false;navigation.scale=scale;
  navigation.centerX=g.anchor.x-(x-m.clientLeft-m.width/2)/(sourceWidth*scale);
  navigation.centerY=g.anchor.y-(y-m.clientTop-m.height/2)/(sourceHeight*scale);
  fitImage();announceNavigation();return;
 }
 if(g.id!==event.pointerId)return;
 const dx=event.clientX-g.startX,dy=event.clientY-g.startY;
 if(g.kind==='tap'&&Math.hypot(dx,dy)>6)g.kind='pan';
 if(g.kind==='pan'){
  navigation.centerX=g.startCenterX-dx/(sourceWidth*g.scale);
  navigation.centerY=g.startCenterY-dy/(sourceHeight*g.scale);
  fitImage();return;
 }
 if(g.kind==='split'){moveComparison(event.clientX);return;}
 if(g.kind==='pick'&&(g.didPick||Math.hypot(dx,dy)>3))beginGesturePick(g,event);
}
function imagePointerEnd(event,cancelled=false){
 if(!imagePointers.has(event.pointerId))return;
 const g=imageGesture;imagePointers.delete(event.pointerId);
 if(g?.kind==='pinch'){
  if(imagePointers.size>=2)startImagePinch();
  else if(imagePointers.size===1){
   const [id,p]=[...imagePointers.entries()][0];
   imageGesture={kind:'pan',id,startX:p.x,startY:p.y,startCenterX:navigation.centerX,startCenterY:navigation.centerY,scale:navigation.scale};
  }else imageGesture=null;
 }else{
  imageGesture=null;draggingImage=draggingSplit=false;
  if(cancelled)undoGesturePick(g);
  else if(!working&&!exporting&&g){
   if(g.kind==='pick'||g.kind==='tap'){
    const rect=$('imageWindow').getBoundingClientRect(),frame=$('imageFrame').getBoundingClientRect();
    const inside=event.clientX>=Math.max(rect.left,frame.left)&&event.clientX<=Math.min(rect.right,frame.right)&&event.clientY>=Math.max(rect.top,frame.top)&&event.clientY<=Math.min(rect.bottom,frame.bottom);
    if(inside||g.didPick)beginGesturePick(g,event,true);
   }else if(g.kind==='split')moveComparison(event.clientX);
  }
 }
 releaseImagePointer(event.pointerId);updateView();
}
$('imageWindow').addEventListener('pointerenter',()=>{pointerOverImage=true;});
$('imageWindow').addEventListener('pointerleave',()=>{pointerOverImage=false;});
$('imageWindow').addEventListener('pointerdown',imagePointerDown);
$('imageWindow').addEventListener('pointermove',imagePointerMove);
$('imageWindow').addEventListener('pointerup',event=>imagePointerEnd(event,false));
$('imageWindow').addEventListener('pointercancel',event=>imagePointerEnd(event,true));
$('imageWindow').addEventListener('lostpointercapture',event=>imagePointerEnd(event,true));
$('imageWindow').addEventListener('auxclick',event=>{if(event.button===1)event.preventDefault();});
$('compareHandle').addEventListener('keydown',event=>{if(event.key==='ArrowLeft'||event.key==='ArrowRight'){event.preventDefault();event.stopPropagation();split=clamp(split+(event.key==='ArrowRight'?1:-1)*(event.shiftKey?10:2),0,100);layoutComparison();}});
$('viewport').addEventListener('wheel',event=>{
 if(!ready||working||exporting)return;
 event.preventDefault();
 if(imagePointers.size||!event.deltaY)return;
 const m=imageMetrics(),unit=event.deltaMode===1?16:event.deltaMode===2?(m?.height||500):1;
 const delta=clamp(event.deltaY*unit,-500,500);
 setImageZoom(navigation.scale*Math.exp(-delta*.002),event.clientX,event.clientY);
},{passive:false});
$('zoomInBtn').addEventListener('click',()=>stepImageZoom(1));
$('zoomOutBtn').addEventListener('click',()=>stepImageZoom(-1));
$('zoomFitBtn').addEventListener('click',()=>{if(ready&&!working&&!exporting){resetImageView();updateView();}});
$('zoomSelect').addEventListener('change',()=>{
 if($('zoomSelect').value==='fit'){resetImageView();updateView();}
 else setImageZoom(Number($('zoomSelect').value));
});
$('panBtn').addEventListener('click',toggleHand);

// Palette interactions: dragging within the band moves its centre; the lower
// handles adjust the half-width around the centre. Hue bands wrap around 0/1.
let graphDrag=null;
function graphValue(event){const r=$('curveCanvas').getBoundingClientRect();return clamp((event.clientX-r.left-8)/(r.width-16),0,1);}
function graphMove(event){
 if(!graphDrag)return;
 const t=graphValue(event);
 if(graphDrag==='width'){
  let d=Math.abs(t-params[focusKey('center')]/100);if(resolvedMode==='hue')d=Math.min(d,1-d);
  params[focusKey('width')]=clamp(Math.round(d*2000)/10,.5,100);
 }else{setPlaneCenter(Math.round(t*1000)/10);}
 touchSettings();
}
$('curveCanvas').addEventListener('pointerdown',event=>{
 if(event.button!==0||working||exporting)return;
 event.preventDefault();
 const r=$('curveCanvas').getBoundingClientRect(),t=graphValue(event),c=params[focusKey('center')]/100,h=params[focusKey('width')]/200;
 let edges=[c-h,c+h];if(resolvedMode==='hue')edges=edges.map(v=>(v+1)%1);
 const close=edges.some(v=>v>=0&&v<=1&&Math.abs(t-v)*(r.width-16)<9);
 graphDrag=close&&event.clientY-r.top>r.height-35?'width':'center';
 $('curveCanvas').setPointerCapture(event.pointerId);graphMove(event);
});

$('curveCanvas').addEventListener('pointermove',graphMove);$('curveCanvas').addEventListener('pointerup',()=>{graphDrag=null;});$('curveCanvas').addEventListener('pointercancel',()=>{graphDrag=null;});
function nudge(event){
 if(event.currentTarget===$('imageFrame')&&(navigation.hand||navigation.space)&&['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key)){
  if(working||exporting)return;event.preventDefault();const step=event.shiftKey?100:32;
  navigation.centerX+=((event.key==='ArrowRight'?1:0)-(event.key==='ArrowLeft'?1:0))*step/(sourceWidth*navigation.scale);
  navigation.centerY+=((event.key==='ArrowDown'?1:0)-(event.key==='ArrowUp'?1:0))*step/(sourceHeight*navigation.scale);fitImage();return;
 }
 if(working||exporting||detailIndexForView()>=0||(event.key!=='ArrowLeft'&&event.key!=='ArrowRight'))return;event.preventDefault();const key=focusKey('center');if(planeActive()){const pl=params.planes[activeFocus-1];pl.slide=Math.round(clamp(pl.slide+(event.key==='ArrowRight'?1:-1)*(event.shiftKey?2:.2),-100,100)*10)/10;}else setPlaneCenter(Math.round(clamp(params[key]+(event.key==='ArrowRight'?1:-1)*(event.shiftKey?2:.2),0,100)*10)/10);touchSettings();}
$('curveCanvas').addEventListener('keydown',nudge);$('imageFrame').addEventListener('keydown',nudge);

// Drop onto the desired detail card, or hold Shift for the selected slot.
// The full-window drop overlay ignores pointer events, so the target stays accurate.
let dragDepth=0,dropTarget='depth';
function targetForDrop(event){
 if(event.target.closest?.('#depthSection,#depthDialog'))return 'depth2';
 const card=event.target.closest?.('[data-layer]');
 if(card)return 'detail'+card.dataset.layer;
 if(event.shiftKey||event.target.closest?.('#detailDialog,#detailSection'))return 'detail'+activeDetail;
 return 'depth';
}
function setDropTarget(target){
 dropTarget=target;$('dropTitle').textContent=target==='depth'?'Drop a depth map.':target==='depth2'?'Drop your second depth map.':'Drop into Detail '+(Number(target.slice(-1))+1)+'.';
 $('depthSection').dataset.drag=String(target==='depth2');
 for(let i=0;i<2;i++)$('detailCard'+(i+1)).dataset.drag=String(target==='detail'+i);
}
function clearDrop(){$('depthSection').dataset.drag='false';dragDepth=0;$('dropOverlay').hidden=true;for(let i=0;i<2;i++)$('detailCard'+(i+1)).dataset.drag='false';}
window.addEventListener('dragenter',event=>{if([...event.dataTransfer.types].includes('Files')){event.preventDefault();dragDepth++;if(!working&&!exporting){setDropTarget(targetForDrop(event));$('dropOverlay').hidden=false;}}});
window.addEventListener('dragover',event=>{if([...event.dataTransfer.types].includes('Files')){event.preventDefault();setDropTarget(targetForDrop(event));}});
window.addEventListener('dragleave',event=>{if([...event.dataTransfer.types].includes('Files')){dragDepth=Math.max(0,dragDepth-1);if(!dragDepth)clearDrop();}});
window.addEventListener('drop',event=>{
 event.preventDefault();const target=targetForDrop(event);clearDrop();
 if(working||exporting)return;
 const file=[...event.dataTransfer.files].find(f=>f.type.startsWith('image/')||/\.(png|jpe?g|webp|avif|bmp|gif)$/i.test(f.name));
 if(file){if(target==='depth2')loadDepth2Image(file,file.name);else if(target!=='depth')loadDetailImage(file,file.name,false,Number(target.slice(-1)));else loadImage(file,file.name);}
 else toast('Drop an image file, rather than a web link or another file type.',true);
});
window.addEventListener('paste',event=>{
 if(working||exporting||$('helpDialog').open||$('settingsDialog').open||$('planeDialog').open)return;
 const item=[...(event.clipboardData?.items||[])].find(i=>i.type.startsWith('image/'));
 if(item){event.preventDefault();const file=item.getAsFile();if(file){if($('depthDialog').open)loadDepth2Image(file,file.name||'pasted-depth-map-2.png');else if($('detailDialog').open)loadDetailImage(file,file.name||'pasted-detail.png',false,activeDetail);else loadImage(file,file.name||'pasted-depth-map.png');}}
});
window.addEventListener('keydown',event=>{
 const tag=event.target.tagName,editing=['INPUT','SELECT','TEXTAREA'].includes(tag)||event.target.isContentEditable;
 const modal=Boolean(document.querySelector('dialog[open]')); 
 if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='o'&&!modal){event.preventDefault();if(!working&&!exporting)$(event.shiftKey?detailId('detailInput'):'fileInput').click();return;}
 if(modal)return;
 if(event.key==='Escape'&&picking){picking=false;updateView();return;}
 if(editing||event.ctrlKey||event.metaKey||event.altKey)return;
 if(ready&&!working&&!exporting){
  if(['+','=','-','_'].includes(event.key)){event.preventDefault();stepImageZoom(event.key==='+'||event.key==='='?1:-1);return;}
  if(event.key.toLowerCase()==='f'||event.key==='0'){event.preventDefault();resetImageView();updateView();return;}
  if(event.key.toLowerCase()==='h'&&!event.repeat){event.preventDefault();toggleHand();return;}
  if(event.code==='Space'&&(tag!=='BUTTON'||pointerOverImage)){
   event.preventDefault();navigation.space=true;syncNavigation();return;
  }
 }
 if(event.key==='?'&&!event.repeat){event.preventDefault();$('helpDialog').showModal();}
 if(event.key.toLowerCase()==='p'&&!event.repeat&&ready&&!working&&!exporting){event.preventDefault();togglePicker(activeFocus);}
 if(['a','b'].includes(event.key.toLowerCase())&&!event.repeat&&ready&&!working&&!exporting){event.preventDefault();selectFocus(event.key.toLowerCase()==='b'?2:1,true);}
 if(['1','2'].includes(event.key)&&!event.repeat){event.preventDefault();selectDetailLayer(Number(event.key)-1);}
 if(event.key.toLowerCase()==='d'&&!event.repeat&&detailLayers[activeDetail].image){event.preventDefault();toggleDetail();}
 if(event.key.toLowerCase()==='s'&&!event.repeat&&ready){event.preventDefault();holdSource=true;updateView();}
});
window.addEventListener('keyup',event=>{if(event.code==='Space'){navigation.space=false;updateView();}if(event.key.toLowerCase()==='s'&&holdSource){holdSource=false;updateView();}});
window.addEventListener('blur',()=>{holdSource=false;navigation.space=false;clearImageGesture();graphDrag=null;updateView();});
if(typeof ResizeObserver!=='undefined'){new ResizeObserver(()=>{fitImage();drawCurve();}).observe($('viewport'));new ResizeObserver(drawCurve).observe($('curveCanvas'));}else window.addEventListener('resize',()=>{fitImage();drawCurve();});
if(window.visualViewport)window.visualViewport.addEventListener('resize',fitImage);
if(uiDarkQuery.addEventListener)uiDarkQuery.addEventListener('change',()=>{drawCurve();queuePlaneDraw();});
else if(uiDarkQuery.addListener)uiDarkQuery.addListener(()=>{drawCurve();queuePlaneDraw();});
$('busyOverlay').hidden=true;
syncControls();
$('canvasHint').textContent='Open or drop a depth map to begin.';
updateView();

// Optional animation UI/code loads only on demand; PNG remains independent.
const videoButton = $('videoBtn') || (() => {
 const button = document.createElement('button');
 button.id = 'videoBtn'; button.type = 'button'; button.textContent = 'MP4';
 button.title = 'Animate a depth band: start → turnaround → start';
 button.setAttribute('aria-label', 'Export a depth boomerang as MP4');
 $('exportBtn').before(button);
 return button;
})();
const syncVideoButton = () => { videoButton.disabled = !ready || working || exporting; };
new MutationObserver(syncVideoButton).observe($('exportBtn'), { attributes: true, attributeFilter: ['disabled'] });
syncVideoButton();
videoButton.addEventListener('click', async () => {
 if (!ready || working || exporting) return;
 exporting = true; version++; setBusy(true, 'Animation settings open…');
 try {
  const { openBoomerang } = await import('./boomerang.js?v=20261005-wasm3');
  const detailSettings = detailSettingsSnapshot(), mix = depthMixSnapshot();
  const snapshot = { params: snapshotParams(), mode: resolvedMode, width: sourceWidth, height: sourceHeight, name: sourceName, sourceVersion: loadToken, focus: activeFocus, previewWidth, previewHeight, details: detailSettings, depthMix: mix, depth2Mode: secondaryDepth.mode };
  await openBoomerang({
   snapshot,
   preview: async parameters => {
    const result = await engine.request('render', { params: parameters, details: detailSettings, depthMix: mix });
    return result.buffer;
   },
   makeBitmaps: async () => {
    const images = { source: null, depth2: null, details: [null, null] };
    try {
     images.source = await createImageBitmap(sourceImage);
     if (mix.enabled && mix.weight > 0) images.depth2 = await createImageBitmap(secondaryDepth.image);
     for (let i = 0; i < 2; i++) if (detailLayers[i].image && detailSettings[i].enabled && detailSettings[i].opacity > 0) images.details[i] = await createImageBitmap(detailLayers[i].image);
     return images;
    } catch (error) { for (const image of [images.source, images.depth2, ...images.details]) image?.close(); throw error; }
   }
  });
 } catch (error) { toast(error.message || 'Animation export could not open. PNG export is still available.', true); }
 finally { exporting = false; setBusy(false); queueRender(); }
});
