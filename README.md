# Depth Photography

A browser-based depth-map editor that turns depth data into selective black-and-white focus planes, with adjustable depth blending, 3D plane rotation, and image-detail overlays.

The app is a standalone HTML file: open `index.html` directly in a modern browser. Processing stays local in the browser.

## Features

- Select one or two depth focus bands and shape their width and softness
- Mix two depth maps to reduce uncorrelated depth noise
- Add up to two grayscale detail layers with Multiply or Overlay blending
- Advanced 3D focus-plane rotation and positioning
- Zoom the preview up to 400% with pan controls
- Export the processed result as PNG
- Responsive light/dark interface inspired by the visual language of Lossless Crop

## Idea and inspiration

The core idea for using depth maps as a photographic editing medium was inspired by [Vathography](https://vathography.com/).

This project explores that idea as a lightweight browser tool, without requiring Blender for the basic workflow.

## Usage

1. Open `index.html`.
2. Load a depth map.
3. Pick a depth or enable a second focus.
4. Optionally mix a second depth map or add detail layers.
5. Use Advanced mode for a rotated 3D focus plane.
6. Export the final PNG.

## Notes

- Colourized depth maps are decoded approximately; lossless grayscale depth maps generally produce cleaner results.
- The current browser pipeline is still an 8-bit workflow; 16-bit depth support is not yet implemented.
- Images are processed locally and are not uploaded by the app.
