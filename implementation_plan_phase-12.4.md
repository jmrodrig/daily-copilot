# Resolution Plan: Phase 12.4 (Pressure Sensitive Strokes)

## 1. Overview
The current markup engine has basic hardware pressure detection (scaling width based on `e.pressure`), but this requires a compatible hardware stylus and doesn't look smooth due to native Canvas `lineTo` segments. The user wants rich, elegant, pressure-sensitive strokes for their markups.

We will integrate `perfect-freehand`, the industry standard for drawing smooth, tapered, pressure-sensitive strokes. It mathematically generates elegant vector outlines based on drawing velocity and hardware pressure.

## 2. Requirements

### A. Install perfect-freehand
- Run `npm install perfect-freehand` in the `desktop` directory.

### B. Integrate into MediaLightbox.tsx
- Import `getStroke` from `perfect-freehand`.
- Modify the `Stroke` type or how `Stroke` points are rendered. Note: `perfect-freehand` generates an array of points `[x, y]` representing the *outline* of the polygon.
- In `drawStrokes` (and `drawSegment` etc.), when drawing a freehand stroke (`type === "draw"`):
  - Pass the stroke's raw points (`x, y, pressure`) into `getStroke`.
  - Provide options to `getStroke`: `size: lineSize / view.zoom`, `thinning: 0.5`, `smoothing: 0.5`, `streamline: 0.5`.
  - Draw the resulting polygon using Canvas 2D (`context.moveTo`, `context.lineTo` across the polygon points, then `context.fill()`).
- In `pointerMove` and `pointerDown`:
  - Continue saving the raw points and `pressure` into the stroke's `points` array.
  - When actively drawing (`drawing.current`), render the "live" stroke using `getStroke`.

### C. Refactor Eraser Logic
- **Crucial:** Because freehand strokes will now be drawn as filled polygons instead of lines with a `lineWidth`, ensure the Stroke Eraser (`type === "erase"`) hit detection still works.
- `perfect-freehand` handles the thickness of the line, so for erase hit detection on freehand strokes, you might just test distance to the raw stroke points, or test if the pointer falls inside the polygon boundary if needed. (Testing distance to the raw points is usually fine and computationally cheaper).

## 3. Implementation Instructions
1. You are on `phase-12.2` (Option 1). We will branch to `phase-12.4`.
2. Install the library.
3. Replace the native `lineTo` freehand drawing with `perfect-freehand` polygons in `MediaLightbox.tsx`.
4. Run `npm run build` to verify.
5. Stage and commit to `phase-12.4`.
