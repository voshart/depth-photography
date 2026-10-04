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
