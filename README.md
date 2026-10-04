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
```

Optional real AVC/HEVC packet round-trip tests, requiring local FFmpeg/ffprobe with libx264 and libx265:

```sh
node tests/mp4-roundtrip.mjs
```

The round-trip test verifies frame count, dimensions, duration, fast-start placement and identical decoded pixels, including reordered H.264 frames. It does not establish WebCodecs hardware support on a user's browser. Test an actual export on each target device.

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
