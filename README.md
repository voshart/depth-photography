# Depth Photography

A browser-based depth-map editor that turns depth data into selective black-and-white focus planes, with adjustable depth blending, 3D plane rotation, and image-detail overlays.

The core idea for using depth maps as a photographic editing medium was inspired by [Vathography](https://vathography.com/).

## Features

- One or two depth focus bands with adjustable width and softness
- Optional averaging of two depth maps to reduce uncorrelated depth noise
- Two grayscale detail layers with Multiply or Overlay blending
- Advanced 3D focus-plane rotation and positioning
- Preview zoom up to 400% with pan controls
- Full-resolution PNG export
- Responsive light/dark interface
- Local browser processing; images are not uploaded by the app

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
- `processor.worker.js` — worker entry point for off-main-thread processing
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
