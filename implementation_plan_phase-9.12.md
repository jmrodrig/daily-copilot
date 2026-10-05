# Implementation Plan: Phase 9.12 - Flattened Resolution Fix
**Task ID:** phase-9.12

## Goal
Fix the pixelation that occurs *after* the markup canvas is flattened and saved. Currently, the high-resolution vector ink is downscaled to match the original image's intrinsic pixel dimensions when `merged.toBlob()` is called. If the original image is small (e.g. 600x400) but displayed large on a retina screen, the saved ink becomes heavily pixelated.

## Scope
### 1. High-Resolution Merged Canvas (`desktop/src/components/ImageLightbox.tsx`)
- In the `save()` function, instead of creating the `merged` canvas strictly at `size.width` x `size.height`, calculate the required resolution to preserve the ink sharpness.
- **Scale Factor:** Use `const saveScale = typeof window !== 'undefined' ? window.devicePixelRatio : 1;` (or similar logic to capture the physical pixel density, or simply take the actual physical dimensions of the markup `<canvas>` buffer itself).
- Alternatively, you can just use `canvas.width` and `canvas.height` as the merged canvas dimensions (since the `canvasRef` currently holds a high-resolution buffer that scales with the zoom). 
  - *Wait:* The markup `<canvas>` scales its physical width based on `Math.max(1, view.zoom)`. If the user is zoomed in 500%, `canvas.width` is 5x larger. Saving an image 5x larger is excessive and will bloat the file.
  - *Best approach:* Set `merged.width = size.width * pixelRatio` and `merged.height = size.height * pixelRatio`, where `pixelRatio = window.devicePixelRatio`.
- **Drawing:** 
  ```javascript
  const pixelRatio = window.devicePixelRatio || 1;
  merged.width = Math.round(size.width * pixelRatio);
  merged.height = Math.round(size.height * pixelRatio);
  // Draw the base image scaled up to the merged canvas size
  context.drawImage(image, 0, 0, merged.width, merged.height);
  // Draw the markup canvas (which might be physically larger or smaller) scaled to match the merged canvas
  context.drawImage(canvas, 0, 0, merged.width, merged.height);
  ```

### 2. Backward Compatibility
- Ensure that the saved image still fits the visual layout in `NotePage.tsx` and `NoteEditor.tsx`. Since CSS already uses `width="100%"` or specific layout constraints, saving the physical PNG file at 2x or 3x resolution will simply act as a Retina-ready image and will not break the document layout.

## Execution Order
1. Update `save()` in `ImageLightbox.tsx` to multiply the merged canvas dimensions by `window.devicePixelRatio`.
2. Update the `context.drawImage` calls to correctly map both the source image and the markup `<canvas>` into this new high-resolution `merged` coordinate space.
