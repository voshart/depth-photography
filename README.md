# Depth Photography

A browser-based depth-map editor that turns depth data into selective black-and-white focus planes, with adjustable depth blending, 3D plane rotation, and image-detail overlays.

**Live demo:** https://depth.voshart.com/

The core idea for using depth maps as a photographic editing medium was inspired by [Vathography](https://vathography.com/).

## Features

- One or two depth focus bands with adjustable width and softness
- Optional averaging of two depth maps to reduce uncorrelated depth noise
- Two grayscale detail layers with Multiply or Overlay blending
- Advanced 3D focus-plane rotation and positioning
- Preview zoom up to 400% with pan controls
- Full-resolution PNG export
- Browser-side boomerang MP4 export with H.264 and conditional H.265 support
- Responsive light/dark interface
- Local browser processing; images are not uploaded by the app

## Boomerang MP4 — first pass

Use **MP4**, beside Export PNG, after loading a depth map. Choose Focus A or B, set **Start** and **Turnaround**, and use Play or the scrubber to inspect the motion. **Use current** copies the band's position from the editor; **Full sweep** and **Swap endpoints** provide quick starting points.

**Whole loop** is the complete start → turnaround → start cycle, not the time for each leg. The default is 4 seconds at 30 fps, with 2 seconds in each direction. Ease in/out and linear motion are available. The exporter rounds the duration to an even number of frames so the turnaround lands exactly on a frame; the actual duration is displayed before rendering. It does not append a duplicate copy of the first frame at the end.

Click **Render MP4**, inspect the finished video, then **Download MP4**. The file contains one silent cycle; the in-app player loops it. Closing the dialog or using Cancel export stops the worker and leaves the still-image settings unchanged.

### What moves

Only the selected band moves; the other enabled band stays still. Flat bands animate depth position. An enabled Advanced 3D plane animates **slide along its normal**, with its pivot and rotation fixed. Both depth inputs and both enabled detail layers are included. This first pass does not animate rotation or create a camera orbit. Near/far order depends on the map encoding; hue mode is a colour sweep, not a physical depth sweep.

### Resolution, codecs and practical limits

- **Native** renders from the original images, not the 1,500-pixel preview. Zoom never crops the video. Smaller long-side sizes are optional and never applied silently.
- For odd dimensions, the encoder frame adds one repeated edge pixel at the right and/or bottom. Source pixels are not cropped or squeezed; the exact MP4 dimensions are shown before export.
- **H.264 MP4** is the default. **H.265/HEVC** is available only if the browser supports encoding the selected configuration. Support is checked again when rendering starts; drivers can still fail at runtime. Try a smaller output or another browser if an encoder is unavailable.
- Video export requires WebCodecs, OffscreenCanvas and module workers on HTTPS (or localhost). It is an **8-bit, silent, lossy video** workflow. Transparency is composited over black. PNG remains available when video encoding is unsupported.
- First-pass limits: **0.5–30 seconds**, **24/30/60 fps**, **16 megapixels / 8,192 pixels per side**, and **128 MB of encoded video in memory**. Device limits can be lower. Large native clips may be slow or exhaust memory on phones; start with a small output.

Depth and grayscale details are decoded/aligned once, then frames are rendered in a dedicated worker using the same focus/detail functions as PNG export. Raw frames are not accumulated into a sequence; encoder backpressure is respected. Export does not have to run in real time. Keep the tab open until it completes.

The animation code loads only when MP4 is opened. Video encoding uses the browser's WebCodecs implementation, with a small in-repository writer for a single constant-frame-rate AVC/HEVC MP4 track. No remote encoder, FFmpeg/WASM download, CDN, package install, or additional Cloudflare build step is used.

## Generate a depth map

**Recommended as of 4 October 2026:** [Marigold V2](https://github.com/huawei-bayerlab/marigold-v2) is the depth model recommended for this workflow. It produces sharp monocular depth estimates and the project describes its current results as state of the art.

You can try the [public Marigold V2 Hugging Face demo](https://huggingface.co/spaces/toshas/Marigold-V2), but treat it as a **non-private third-party service**.

> **PRIVACY WARNING:** Any image uploaded to the public demo leaves this app and is processed on infrastructure outside your control. Do not upload private, confidential, identifying, client, unreleased, or otherwise sensitive images. This project cannot verify or guarantee how a third-party demo retains or uses uploads.

For sensitive work, **download the official code and weights and run Marigold V2 locally**:

- [Marigold V2 source / local inference](https://github.com/huawei-bayerlab/marigold-v2)
- The official repository currently states that inference needs about **17 GB of GPU memory at 1024²** and **29 GB at 2048²**.
- This recommendation is deliberately date-stamped. Monocular depth is moving quickly, so a better model may replace it within weeks or months.

## Project structure

The site is dependency-free and designed for static hosting:

- `index.html` — interface markup
- `app.css` — interface styling
- `app.js` — UI state, canvas interaction, import/export and orchestration
- `processor.js` — shared depth and pixel-processing implementation
- `processor.worker.js` — worker entry point for off-main-thread still processing
- `processor-wasm.js` / `wasm/depth-kernels.wasm` — optional Rust acceleration for flat/hue bands and rotated 3D planes
- `rust/` — dependency-free Rust source; `scripts/build-wasm.sh` rebuilds the shipped binary
- `boomerang.js` / `boomerang.css` — lazy-loaded animation dialog and controller
- `boomerang-core.js` — timing, endpoints, output sizing and codec capability checks
- `boomerang-render.js` — native-resolution depth/detail cache and frame rendering
- `boomerang.worker.js` — frame scheduling and WebCodecs video encoding
- `mp4.js` — video-only ISO BMFF/MP4 packaging
- `tests/` — animation and MP4 tests
- `assets/example-depth.jpg` — optional example depth map, loaded only when requested
- `assets/example-normal.jpg` — optional example detail/normal map, loaded only when requested

The example files retain their original JPEG bytes. They were previously embedded in the HTML as Base64 data; separating them allows independent browser/CDN caching and avoids downloading them until the example is requested.

## Run locally

Because the app uses JavaScript modules and a module Worker, serve the repository over HTTP rather than opening `index.html` directly from `file://`.

For example:

```sh
python3 -m http.server 8000
```

Then open `http://localhost:8000/`.

## Tests

Pure animation, validation and detail-blending tests (Node.js 22 or later):

```sh
node tests/boomerang.test.mjs
node tests/wasm.test.mjs
```

Optional real AVC/HEVC packet round-trip tests, requiring local FFmpeg/ffprobe with libx264 and libx265:

```sh
node tests/mp4-roundtrip.mjs
```

The round-trip test verifies frame count, dimensions, duration, fast-start placement and identical decoded pixels, including reordered H.264 frames. It does not establish WebCodecs hardware support on a user's browser. Test an actual export on each target device.

## Rendering performance

Flat/hue bands and rotated 3D planes use dependency-free Rust/WASM kernels for
frames or strips of at least 16,384 pixels. Still previews and MP4 frames retain
immutable decoded depth and source alpha between updates. Rotated-plane tone
curves are reused until profile, contrast, lift, background or inversion changes.

Detail blending caches a byte-exact 256 × 256 lookup for each opacity/blend setting
(up to four tables). Prepared textures whose visible pixels are at least 80%
opaque use a Rust lookup pass with retained texture inputs. Mostly translucent
textures keep the JavaScript arithmetic path, which measured faster for that case.
Both Multiply and Overlay preserve source alpha; uncovered Fit margins have no
effect. Separate texture/focus workspaces prevent one pass from evicting the
other's inputs, and both detail layers share one output workspace.

The slider scheduler combines input bursts into one UI update per animation frame
and keeps just one preview render in flight. A completed frame is displayed even
if another slider position is waiting; the next render uses the newest settings.
This avoids freezing the preview during a continuous drag. Image replacement,
encoding changes, alignment and other busy operations invalidate older results.
The displayed preview buffer is transferred back to the worker for reuse after
Canvas has copied its pixels, reducing full-image allocation/GC pressure.

Unchanged depth/detail controls and image-info DOM are no longer rebuilt during
every focus update. Observed state attributes are written only when they change,
the tone-curve canvas is resized only when needed, and unchanged grayscale-detail
previews are not repainted.

The interface, image decoding and browser video encoder remain JavaScript/browser
APIs. A failed WASM download, blocked WebAssembly or unsupported browser
uses the JavaScript fallback. No image data leaves the browser, and there are no
runtime dependencies or CDN requests. The shipped WASM is approximately 24 KB;
static hosting requires **no build step**.

### Measurements and limits

Local synthetic Node 24/V8 measurements at 1,500 × 1,000 pixels:

| Render workload | Earlier implementation | Updated implementation |
| --- | ---: | ---: |
| Flat focus, successive positions | ~6.2 ms original JS | ~2.6 ms Rust/WASM with reused output |
| Flat focus + one opaque detail | ~21 ms previous PR | ~7.3 ms |
| Flat focus + two opaque details | ~37 ms previous PR | ~11.6 ms |
| Flat focus + two uniformly translucent details | ~37 ms previous PR | ~37 ms (JavaScript path) |
| Rotated two-plane focus | ~56 ms original JS | ~26 ms Rust/WASM |

The detail-slider test changes position over 80 renders and discards the first 12
for warm-up. In one run, two opaque details improved p95 from ~47 ms to ~14 ms;
slow-frame timing remains sensitive to allocation, GC and device load. The flat
slider benchmark changes position over 120 renders and reports first-frame,
median, p95 and max separately. These processing measurements include lookup,
input handling and output copies, but exclude worker messaging, Canvas paint,
other UI work, image decoding and video encoding. Actual browser slider frame
rates still need desktop/mobile testing. Lower render time does not guarantee
no stutter, and translucency, layer settings and device memory affect results.

Run the benchmarks:

```sh
node tests/flat-slider-benchmark.mjs
node tests/detail-slider-benchmark.mjs
node tests/wasm-benchmark.mjs
```

The detail benchmark accepts an optional old `processor-wasm.js` adapter path
(whose processor import points at the old implementation) as its first argument
for a before/after comparison. Buffer reuse requests are ignored by old processors.

Validation checks 144 flat/hue and 72 spatial output variants, every one of the
65,536 base/detail intensity pairs at ten blend/opacity settings and four coverage
alphas, translucent edges on otherwise opaque layers, cache eviction, retained
input replacement, PNG strips, source alpha and failed WASM loads. Scheduler tests
cover burst coalescing, progress during continuous input, final-position accuracy,
changed-image invalidation and error recovery. Transfer tests exercise detached
preview buffers, flat/spatial alternation and texture replacement.

```sh
node tests/wasm.test.mjs
node tests/detail-lookup.test.mjs
node tests/preview-buffer.test.mjs
node tests/preview-scheduler.test.mjs
node tests/boomerang.test.mjs
```

To rebuild, install Rust/rustup; `rust-toolchain.toml` pins the compiler and target:

```sh
sh scripts/build-wasm.sh
```

GitHub Actions tests the shipped binary, rebuilds Rust and reruns the rendering
checks. Hosts without a WASM MIME type are supported through an ArrayBuffer
loader. If a custom Content Security Policy blocks WASM, JavaScript remains usable.

## Cloudflare Pages

This repository is deploy-ready; there is no package install or compilation step.

Recommended Pages settings:

- Framework preset: `None`
- Production branch: `main`
- Build command: `exit 0`
- Build output directory: `/` (repository root)
- Root directory: leave blank
- Environment variables: none

## Notes

- Colourized depth maps are decoded approximately; lossless grayscale depth maps generally produce cleaner results.
- The current browser pipeline is an 8-bit workflow; native 16-bit depth support is not yet implemented.
- No third-party runtime dependencies, frameworks, CDNs, external fonts, or remote scripts are required.
