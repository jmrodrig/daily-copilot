# Implementation Plan: Phase 9.11 - Canvas Resolution Fix
**Task ID:** phase-9.11

## Goal
Fix the stroke pixelation issue in the Lightbox markup mode. Currently, the `<canvas>` is statically sized to the intrinsic width/height of the image. When the user zooms in (via CSS transform), the browser scales up the low-resolution canvas bitmap, causing severe pixelation of newly drawn strokes. 

## Scope
### 1. High-Resolution Dynamic Canvas (`desktop/src/components/ImageLightbox.tsx`)
- Compute a `renderScale` dynamically: `const renderScale = window.devicePixelRatio * Math.max(1, view.zoom)`.
- Update the `<canvas>` physical dimensions to multiply the original image dimensions by `renderScale`:
  ```tsx
  <canvas 
    width={size.width * renderScale} 
    height={size.height * renderScale} 
    // keep className w-full h-full so CSS scales it back to 100% of the container
  />
  ```

### 2. Update Drawing Context
- Because the physical canvas is now much larger than the image pixel coordinate space (which is what `strokes` are recorded in), you must apply `context.scale(renderScale, renderScale)` before executing any drawing commands.
- **Redraw Effect (`useEffect`):** Update the effect that loops through and redraws the `strokes`. First `context.resetTransform()`, then `context.clearRect(0, 0, canvas.width, canvas.height)`, then `context.scale(renderScale, renderScale)`, and finally draw the strokes. Add `renderScale` to the dependency array.
- **Immediate Ink (`pointerDown` / `pointerMove`):** When drawing a dot or segment directly in the event handlers, wrap the calls in `context.save(); context.scale(renderScale, renderScale); ...; context.restore();`.

### 3. Update Save/Merge Logic
- In the `save()` function, the off-screen `merged` canvas is created at `size.width` x `size.height`. 
- When calling `context.drawImage(canvas, 0, 0)`, change it to explicitly specify the destination width and height: `context.drawImage(canvas, 0, 0, size.width, size.height)`. This guarantees the oversized, high-resolution drawing canvas is down-sampled cleanly onto the 1x saved image without cropping.

## Execution Order
1. Calculate `renderScale` from `view.zoom` and `window.devicePixelRatio`.
2. Apply `renderScale` to the `<canvas>` `width` and `height` props.
3. Update `save()`, `pointerDown`, `pointerMove`, and the stroke rendering `useEffect` to use `context.scale(renderScale, renderScale)` properly.
