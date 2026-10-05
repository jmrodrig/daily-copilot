# Implementation Plan: Phase 9.13 - Markup Shapes & Eraser
**Task ID:** phase-9.13

## Goal
Expand the stylus markup capabilities in the Image Lightbox to include an Eraser tool and geometric shapes (Lines, Arrows, Rectangles, and Circles).

## Scope
### 1. Data Model Extension (`desktop/src/components/ImageLightbox.tsx`)
- **Extend the `Tool` type:** `type Tool = "draw" | "pan" | "erase" | "line" | "arrow" | "rect" | "circle";`
- **Extend the `Stroke` type:** Add a `type: Tool` discriminator to the stroke objects saved in the `strokes` array, so the renderer knows how to draw each specific stroke.

### 2. Eraser Implementation
- The `<canvas>` overlay in the lightbox ONLY contains the ink strokes (the background image sits underneath it in an `<img>` tag).
- Therefore, to implement a true vector-like eraser that bites into previous strokes, you can simply record the eraser stroke as a freehand trace (just like `"draw"`).
- During the canvas rendering loop (in `useEffect` and `drawOnCanvas`), if `stroke.type === "erase"`, set `context.globalCompositeOperation = "destination-out"`. This will seamlessly erase intersecting ink without affecting the background image. (Remember to reset it to `source-over` for normal strokes).

### 3. Geometric Shapes Implementation
- **Pointer Handling:**
  - For freehand `"draw"` and `"erase"`, pointer movement pushes new points into the `stroke.points` array continuously.
  - For shapes (`"line"`, `"arrow"`, `"rect"`, `"circle"`), the user clicks and drags. The stroke should only ever contain two points: `points[0]` (the start point) and `points[1]` (the current/end point). Update `points[1]` on `pointerMove` instead of pushing new points.
- **Rendering Logic:**
  - Add logic to the stroke rendering loop to handle the shape types using the two coordinate points.
  - `"line"`: `moveTo(start)`, `lineTo(end)`.
  - `"arrow"`: Draw a line from start to end, calculate the angle (`Math.atan2`), and draw two short intersecting lines at the end coordinate to form the arrowhead.
  - `"rect"`: `strokeRect(start.x, start.y, width, height)`.
  - `"circle"` (or Ellipse): Use `context.ellipse()` or `context.arc()` calculating the radius/radii from the bounding box of the start and end points.

### 4. Toolbar UI Updates
- Expand the `role="toolbar"` in `ImageLightbox.tsx` to include buttons/icons for the new tools: Eraser, Line, Arrow, Rect, and Circle.
- Ensure the UI remains compact and intuitive (perhaps grouping shapes or using simple SVG icons).

## Execution Order
1. Update the `Tool` and `Stroke` types.
2. Add the new tool buttons to the Markup toolbar.
3. Modify `pointerDown` and `pointerMove` to handle the two-point logic for shapes.
4. Modify the canvas rendering loop to respect `globalCompositeOperation = "destination-out"` for the eraser, and to mathematically render the specific geometric shapes.
