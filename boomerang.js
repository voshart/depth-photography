import { videoPlan, frameParams, bounceAt, endpointBounds, sweepEndpoints, currentPosition, isPlane } from './boomerang-core.js?v=20261004-3';

let saved = { duration: 4, fps: 30, motion: 'ease', codec: 'avc', resolution: 'native', quality: 'high' };
const endpoints = new Map();
const workerURL = new URL('./boomerang.worker.js?v=20261004-3', import.meta.url);
let stylesheet = null;
function loadStyles() {
  if (!stylesheet) {
    const link = document.createElement('link'); link.rel = 'stylesheet'; link.href = new URL('./boomerang.css?v=20261004-3', import.meta.url).href;
    stylesheet = new Promise((resolve, reject) => { link.onload = resolve; link.onerror = () => { stylesheet = null; link.remove(); reject(new Error('Animation styles did not load. Reload the page and try again.')); }; });
    document.head.append(link);
  }
  return stylesheet;
}
const round = v => Math.round(v * 10) / 10;
const time = seconds => seconds < 60 ? `${Math.round(seconds)}s` : `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
const closeBitmaps = images => { if (images) for (const image of [images.source, images.depth2, ...(images.details || [])]) image?.close(); };

export async function openBoomerang(bridge) {
  await loadStyles();
  const snapshot = bridge.snapshot;
  const dialog = document.createElement('dialog'); dialog.id = 'boomerangDialog'; dialog.setAttribute('aria-labelledby', 'bmTitle');
  dialog.innerHTML = `
    <div class="dialog-head"><h2 id="bmTitle">Depth boomerang</h2><button id="bmClose" class="quiet icon-button" aria-label="Close animation settings">×</button></div>
    <div class="bm-layout">
      <div class="bm-visual">
        <div class="bm-stage"><canvas id="bmCanvas" aria-label="Animation preview"></canvas><video id="bmVideo" controls loop muted playsinline preload="metadata" hidden></video></div>
        <div class="bm-playbar"><button id="bmPlay" aria-pressed="false">Play</button><input id="bmPhase" type="range" min="0" max="1" step="0.001" value="0" aria-label="Scrub the boomerang loop"/></div>
        <output id="bmTime" class="bm-time" for="bmPhase">0.00 s</output>
        <p class="bm-note">Preview may skip frames on slower devices. Export renders every frame, independently of playback speed and canvas zoom.</p>
      </div>
      <div>
        <fieldset class="bm-fields" id="bmFields">
          <label for="bmFocus">Animate</label><select id="bmFocus"><option value="1">Focus A</option><option value="2">Focus B</option></select>
          <p id="bmMode" class="bm-note"></p>
          <div class="bm-pair">
            <div><label for="bmFrom">Start (%)</label><input id="bmFrom" type="number" step="0.1"/><div class="bm-end-buttons"><button id="bmFromCurrent" title="Use this band's current position in the editor">Use current</button><button id="bmShowFrom">View</button></div></div>
            <div><label for="bmTo">Turnaround (%)</label><input id="bmTo" type="number" step="0.1"/><div class="bm-end-buttons"><button id="bmToCurrent" title="Use this band's current position in the editor">Use current</button><button id="bmShowTo">View</button></div></div>
          </div>
          <div class="bm-tools"><button id="bmSweep">Full sweep</button><button id="bmSwap">Swap endpoints</button></div>
          <div class="bm-pair"><div><label for="bmDuration">Whole loop (seconds)</label><input id="bmDuration" type="number" min="0.5" max="30" step="0.1"/></div><div><label for="bmFps">Frame rate</label><select id="bmFps"><option value="24">24 fps</option><option value="30">30 fps</option><option value="60">60 fps</option></select></div></div>
          <div class="bm-pair"><div><label for="bmMotion">Motion</label><select id="bmMotion"><option value="ease">Ease in / out</option><option value="linear">Linear bounce</option></select></div><div><label for="bmCodec">MP4 codec</label><select id="bmCodec"><option value="avc">H.264</option><option value="hevc">H.265 / HEVC</option></select></div></div>
          <div class="bm-pair"><div><label for="bmSize">Resolution</label><select id="bmSize"><option value="native">Native</option><option value="3840">Up to 3840 px</option><option value="2560">Up to 2560 px</option><option value="1920">Up to 1920 px</option><option value="1280">Up to 1280 px</option><option value="960">Up to 960 px</option></select></div><div><label for="bmQuality">Quality</label><select id="bmQuality"><option value="standard">Standard</option><option value="high">High</option></select></div></div>
        </fieldset>
        <p class="bm-summary" id="bmSummary"></p>
        <p class="bm-note" id="bmSupport" role="status" aria-live="polite"></p>
        <p class="bm-note">One silent start → turnaround → start cycle. A 4 s loop takes 2 s each way. Transparency becomes black. Codec support and maximum size depend on your browser and device. Large native exports use substantial memory; choose a smaller size on a phone.</p>
      </div>
    </div>
    <div class="bm-progress"><progress id="bmProgress" max="100" value="0" hidden></progress><p class="bm-status" id="bmStatus" role="status" aria-live="polite">Nothing is uploaded. Keep this tab open until export finishes.</p></div>
    <div class="bm-actions"><button id="bmCancel" hidden>Cancel export</button><button id="bmRender" class="primary" disabled>Render MP4</button><a id="bmDownload" class="bm-download" hidden>Download MP4</a></div>`;
  document.body.append(dialog);
  const $ = id => dialog.querySelector('#' + id), canvas = $('bmCanvas'), ctx = canvas.getContext('2d');
  canvas.width = snapshot.previewWidth; canvas.height = snapshot.previewHeight;
  $('bmFocus').value = String(snapshot.focus);
  $('bmFocus').querySelector('[value="2"]').disabled = !snapshot.params.secondEnabled;
  $('bmDuration').value = saved.duration; $('bmFps').value = saved.fps; $('bmMotion').value = saved.motion;
  $('bmCodec').value = saved.codec; $('bmSize').value = saved.resolution; $('bmQuality').value = saved.quality;
  let settings = null, plan = null, support = null, error = '', probe = null, probeTimer = 0, probeTimeout = 0;
  let task = null, progressTimer = 0, alive = true, exporting = false, session = 0, blobURL = null;
  let phase = 0, playing = false, raf = 0, playbackStart = 0, previewBusy = false, previewAgain = false, previewVersion = 0;
  let focused = snapshot.focus;
  const key = focus => `${snapshot.sourceVersion}|${focus}|${isPlane(snapshot, focus) ? 'plane' : 'flat'}`;
  const status = (message, bad = false) => { $('bmStatus').textContent = message; $('bmStatus').classList.toggle('bm-error', bad); };
  function writeEndpoints() {
    const [lo, hi] = endpointBounds(snapshot, focused), range = endpoints.get(key(focused)) || sweepEndpoints(snapshot, focused);
    for (const id of ['bmFrom', 'bmTo']) { $(id).min = lo; $(id).max = hi; }
    $('bmFrom').value = range[0]; $('bmTo').value = range[1];
    $('bmMode').textContent = isPlane(snapshot, focused)
      ? 'Slide this plane along its normal. Its rotation stays fixed; the other band stays still.'
      : `Sweep this band's depth position. The other band stays still.${snapshot.mode === 'hue' ? ' Hue mode sweeps colour, not physical depth.' : ' Near/far order depends on your map.'}`;
  }
  function readSettings() {
    return { focus: Number($('bmFocus').value), from: $('bmFrom').valueAsNumber, to: $('bmTo').valueAsNumber, duration: $('bmDuration').valueAsNumber, fps: Number($('bmFps').value), motion: $('bmMotion').value, codec: $('bmCodec').value, resolution: $('bmSize').value, quality: $('bmQuality').value };
  }
  function stopPlayback() { playing = false; cancelAnimationFrame(raf); $('bmPlay').textContent = 'Play'; $('bmPlay').setAttribute('aria-pressed', 'false'); }
  function clearResult() {
    $('bmVideo').pause(); $('bmVideo').removeAttribute('src'); $('bmVideo').load(); $('bmVideo').hidden = true; canvas.hidden = false;
    $('bmDownload').hidden = true;
    if (blobURL) { URL.revokeObjectURL(blobURL); blobURL = null; }
  }
  function renderButtons() {
    $('bmFields').disabled = exporting; $('bmRender').disabled = exporting || !plan || !support?.[settings?.codec];
    $('bmCancel').hidden = !exporting; $('bmPlay').disabled = exporting || !plan || Boolean(blobURL); $('bmPhase').disabled = exporting || Boolean(blobURL);
    $('bmClose').title = exporting ? 'Close and cancel the current export' : 'Close animation settings';
  }
  function showPhase(next) {
    phase = next; $('bmPhase').value = phase;
    if (settings) $('bmTime').textContent = `${(phase * (plan?.duration || settings.duration || 4)).toFixed(2)} s · ${round(bounceAt(phase, settings.from, settings.to, settings.motion))}%`;
  }
  async function preview() {
    previewAgain = true;
    if (previewBusy || exporting || !plan || !alive) return;
    previewBusy = true;
    try {
      while (previewAgain && alive && !exporting && plan) {
        previewAgain = false; const version = previewVersion;
        const buffer = await bridge.preview(frameParams(snapshot, settings, phase));
        if (alive && !exporting && !blobURL && version === previewVersion) {
          const rgba = new Uint8ClampedArray(buffer);
          for (let i = 0; i < rgba.length; i += 4) { rgba[i] = rgba[i+1] = rgba[i+2] = Math.round(rgba[i] * rgba[i+3] / 255); rgba[i+3] = 255; }
          ctx.putImageData(new ImageData(rgba, snapshot.previewWidth, snapshot.previewHeight), 0, 0);
        }
      }
    } catch (e) { if (alive) { stopPlayback(); status(e.message || 'Preview failed.', true); } }
    finally { previewBusy = false; }
  }
  function tick(now) {
    if (!playing || !alive || exporting || !plan) return;
    showPhase(((now - playbackStart) / 1000 / plan.duration) % 1); preview(); raf = requestAnimationFrame(tick);
  }
  function capabilityCheck() {
    clearTimeout(probeTimer); clearTimeout(probeTimeout); probe?.terminate(); probe = null; support = null;
    if (!plan) { renderButtons(); return; }
    if (!globalThis.isSecureContext || typeof VideoEncoder === 'undefined' || typeof Worker === 'undefined' || typeof OffscreenCanvas === 'undefined') {
      $('bmSupport').textContent = 'MP4 export needs WebCodecs, workers and OffscreenCanvas on HTTPS (or localhost). This browser does not expose them here. Preview and PNG still work.';
      $('bmSupport').className = 'bm-note bm-warning'; renderButtons(); return;
    }
    $('bmSupport').className = 'bm-note'; $('bmSupport').textContent = 'Checking H.264 / H.265 at the chosen size…'; renderButtons();
    probeTimer = setTimeout(() => {
      if (!alive || exporting || !plan) return;
      let worker;
      try { worker = new Worker(workerURL, { type: 'module' }); probe = worker; }
      catch (e) { $('bmSupport').textContent = 'The export worker could not start. Reload this site or try another browser.'; return; }
      const failed = () => { if (!alive || probe !== worker) return; worker.terminate(); probe = null; clearTimeout(probeTimeout); $('bmSupport').textContent = 'Could not check this browser’s encoder. Change a setting to retry, or reload the site.'; $('bmSupport').className = 'bm-note bm-warning'; renderButtons(); };
      worker.onerror = event => { event.preventDefault(); failed(); };
      probeTimeout = setTimeout(failed, 15000);
      worker.onmessage = ({ data }) => {
        if (!alive || probe !== worker || data.type !== 'support') return;
        clearTimeout(probeTimeout); worker.terminate(); probe = null; support = data.results;
        // Never substitute a codec or resolution without the user's choice.
        $('bmCodec').querySelector('[value="hevc"]').disabled = !support.hevc && settings.codec !== 'hevc';
        $('bmSupport').className = 'bm-note' + (support[settings.codec] ? '' : ' bm-warning');
        $('bmSupport').textContent = support[settings.codec]
          ? `${settings.codec === 'avc' ? 'H.264' : 'H.265'} configuration supported. ${support.hevc ? 'H.265 is also available.' : 'H.265 is unavailable at these settings.'} The actual encoder is checked again when rendering starts.`
          : 'The chosen codec is unavailable at these settings. Choose H.264, a smaller output, or another browser. The app will not silently downscale.';
        renderButtons();
      };
      worker.postMessage({ type: 'probe', snapshot, settings });
    }, 220);
  }
  function changed(check = true) {
    if (exporting) return;
    stopPlayback(); clearResult(); previewVersion++; settings = readSettings(); error = '';
    if (Number.isFinite(settings.from) && Number.isFinite(settings.to)) endpoints.set(key(settings.focus), [settings.from, settings.to]);
    try { plan = videoPlan(snapshot, settings); saved = { ...settings }; }
    catch (e) { error = e.message; plan = null; }
    $('bmSummary').textContent = plan
      ? `${plan.codedWidth.toLocaleString()} × ${plan.codedHeight.toLocaleString()} px · ${plan.native ? 'native image' : 'resized from original'}\n${plan.frames} frames · ${plan.duration.toFixed(2)} s total · ${plan.fps} fps · target ${(plan.bitrate / 1e6).toFixed(1)} Mb/s${plan.padded ? '\nOdd dimensions: one edge pixel is added right/bottom. No source pixels are cropped.' : ''}`
      : error;
    $('bmSummary').classList.toggle('bm-error', !plan);
    $('bmProgress').hidden = true; status('Nothing is uploaded. Keep this tab open until export finishes.');
    showPhase(phase); if (check) capabilityCheck(); else renderButtons(); preview();
  }
  function cancelTask(message = 'Export cancelled. Your still-image settings are unchanged.') {
    session++; task?.terminate(); task = null; clearTimeout(progressTimer); exporting = false;
    $('bmProgress').hidden = true; renderButtons(); status(message); preview();
  }
  function watchdog() {
    clearTimeout(progressTimer);
    progressTimer = setTimeout(() => { if (exporting) { cancelTask(); status('The export stopped responding. No partial clip was saved. Try a smaller size.', true); } }, 120000);
  }
  async function renderVideo() {
    if (exporting || !plan || !support?.[settings.codec]) return;
    stopPlayback(); clearResult(); clearTimeout(probeTimer); probe?.terminate(); probe = null;
    exporting = true; const token = ++session; renderButtons(); $('bmProgress').hidden = false; $('bmProgress').value = 0;
    status('Preparing full-resolution source images…'); watchdog();
    let images = null;
    try {
      const worker = new Worker(workerURL, { type: 'module' }); task = worker;
      const fail = message => { if (!alive || session !== token) return; cancelTask(); status(message, true); };
      worker.onerror = event => { event.preventDefault(); fail('The video worker stopped. Try a smaller output size or reload the page.'); };
      worker.onmessage = ({ data }) => {
        if (!alive || token !== session) return;
        watchdog();
        if (data.type === 'progress') {
          if (data.stage === 'prepare') { $('bmProgress').value = 15 * data.value; status(`Decoding and aligning inputs · ${Math.round(100 * data.value)}%`); }
          else if (data.stage === 'render') { $('bmProgress').value = 15 + 80 * data.value; status(`Rendering ${data.frame} / ${data.frames} frames · ${time(data.elapsed)} elapsed. Cancel is safe.`); }
          else { $('bmProgress').value = 96; status('Finalizing the MP4…'); }
        } else if (data.type === 'error') fail(data.message);
        else if (data.type === 'done') {
          clearTimeout(progressTimer); worker.terminate(); task = null; exporting = false;
          blobURL = URL.createObjectURL(data.blob);
          const base = snapshot.name.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9_\-\u00C0-\u024F ]/g, '_') || 'depth';
          $('bmDownload').href = blobURL; $('bmDownload').download = `${base}-boomerang-${settings.focus === 2 ? 'B' : 'A'}-${settings.codec === 'avc' ? 'h264' : 'h265'}.mp4`;
          $('bmDownload').hidden = false; $('bmVideo').src = blobURL; $('bmVideo').hidden = false; canvas.hidden = true;
          $('bmVideo').muted = true; $('bmProgress').value = 100;
          status(`Ready · ${(data.blob.size / 1048576).toFixed(1)} MB · ${data.plan.duration.toFixed(2)} s. Play to inspect, then Download MP4. The player repeats the single encoded cycle.`);
          renderButtons(); $('bmDownload').focus();
        }
      };
      images = await bridge.makeBitmaps();
      if (!alive || token !== session) { closeBitmaps(images); return; }
      const transfers = [images.source, images.depth2, ...images.details].filter(Boolean);
      worker.postMessage({ type: 'start', snapshot, settings, images }, transfers); images = null;
    } catch (e) {
      closeBitmaps(images);
      if (alive && token === session) { cancelTask(); status(e.message || 'The video export could not start.', true); }
    }
  }
  const unload = event => { if (exporting) { event.preventDefault(); event.returnValue = ''; } };
  window.addEventListener('beforeunload', unload);
  $('bmFocus').addEventListener('change', () => { focused = Number($('bmFocus').value); writeEndpoints(); changed(); });
  for (const id of ['bmFrom','bmTo','bmDuration']) $(id).addEventListener('input', () => changed());
  for (const id of ['bmFps','bmMotion','bmCodec','bmSize','bmQuality']) $(id).addEventListener('change', () => changed());
  for (const [id, target, at] of [['bmFromCurrent','bmFrom',0], ['bmToCurrent','bmTo',.5]]) $(id).addEventListener('click', () => { $(target).value = round(currentPosition(snapshot, focused)); showPhase(at); changed(); });
  $('bmShowFrom').addEventListener('click', () => { stopPlayback(); showPhase(0); preview(); });
  $('bmShowTo').addEventListener('click', () => { stopPlayback(); showPhase(.5); preview(); });
  $('bmSweep').addEventListener('click', () => { const [from,to] = sweepEndpoints(snapshot, focused); $('bmFrom').value = from; $('bmTo').value = to; changed(); });
  $('bmSwap').addEventListener('click', () => { const value = $('bmFrom').value; $('bmFrom').value = $('bmTo').value; $('bmTo').value = value; changed(); });
  $('bmPhase').addEventListener('input', () => { stopPlayback(); showPhase(Number($('bmPhase').value)); preview(); });
  $('bmPlay').addEventListener('click', () => {
    if (playing) { stopPlayback(); return; }
    if (!plan || exporting) return;
    playing = true; $('bmPlay').textContent = 'Pause'; $('bmPlay').setAttribute('aria-pressed', 'true');
    playbackStart = performance.now() - phase * plan.duration * 1000; raf = requestAnimationFrame(tick);
  });
  $('bmRender').addEventListener('click', renderVideo); $('bmCancel').addEventListener('click', () => cancelTask());
  $('bmClose').addEventListener('click', () => dialog.close());
  dialog.addEventListener('cancel', () => { if (exporting) cancelTask(); });
  dialog.addEventListener('keydown', event => event.stopPropagation());
  dialog.addEventListener('paste', event => event.stopPropagation());
  writeEndpoints(); dialog.showModal(); changed();
  return new Promise(resolve => dialog.addEventListener('close', () => {
    alive = false; session++; stopPlayback(); task?.terminate(); probe?.terminate();
    clearTimeout(probeTimer); clearTimeout(probeTimeout); clearTimeout(progressTimer);
    window.removeEventListener('beforeunload', unload); $('bmVideo').pause();
    if (blobURL) { const url = blobURL; setTimeout(() => URL.revokeObjectURL(url), 60000); }
    dialog.remove(); resolve();
  }, { once: true }));
}
