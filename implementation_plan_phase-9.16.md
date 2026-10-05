# Implementation Plan: Phase 9.16 - Transform Lasso Tool & Icon Fixes
**Task ID:** phase-9.16

## Goal
Fix the Lasso Eraser icon, and implement a full "Transform Lasso" tool that allows selecting existing strokes, then moving, scaling, rotating, and deleting them.

## Scope
### 1. Lasso Eraser Icon
- The user requested a new icon for the `lasso-erase` tool that visibly combines the Lasso rope symbol and the Eraser block symbol into one combined 16x16 path.

### 2. Transform Lasso Tool (Select Mode)
- **New Tool Type:** Add a new `"select"` tool to the markup toolbar (using a standard lasso selection icon, e.g., a dashed loop).
- **Selection Logic (Point in Polygon):** 
  - When the user draws a loop using the `"select"` tool, record the lasso path.
  - On `pointerUp`, calculate which existing strokes fall inside the lasso path. (You can check if a stroke's bounding box intersects the lasso, or use a ray-casting point-in-polygon algorithm on the stroke's points).
  - Store the selected strokes in a `selectedStrokes: Set<Stroke>` or array state.
- **Bounding Box & Handles:**
  - When strokes are selected, calculate their collective bounding box.
  - Render a selection box around them on the canvas (or via overlaid HTML `<div>` handles if easier, but canvas drawing is preferred for performance).
  - Draw handles for scaling (corners) and rotating (top center).
- **Transformation Mechanics:**
  - **Move:** Dragging inside the bounding box should translate all points of the selected strokes.
  - **Scale:** Dragging a corner handle should scale the points of the selected strokes relative to the opposite corner.
  - **Rotate:** Dragging the rotation handle should rotate the points of the selected strokes around the center of the bounding box.
  - **Delete:** Pressing the `Delete` or `Backspace` key while strokes are selected should remove them from the `strokes` array.
- **UX Polish:** 
  - Clicking outside the selection should clear the selection.
  - Transformations should update the strokes array in real-time or via a preview stroke mechanism so the user sees the transformation live.

## Execution Order
1. Update the `lasso-erase` icon to a combined visual in `ERASERS`.
2. Add the `"select"` tool to the toolbar and define the `selectedStrokes` state.
3. Implement the lasso loop drawing and the point-in-polygon hit test to populate the selection.
4. Render the selection bounding box and handles.
5. Implement pointer event logic to handle translation, scaling, and rotation of the selected points.
6. Add the keyboard event listener for deletion.
