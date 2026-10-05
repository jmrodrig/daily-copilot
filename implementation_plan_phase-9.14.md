# Implementation Plan: Phase 9.14 - Lasso Eraser, Shift Toggle & Text Tool
**Task ID:** phase-9.14

## Goal
Enhance the markup workflow by adding a Lasso (Area) Eraser, a keyboard shortcut to quickly toggle the eraser, and a Text tool for adding text annotations.

## Scope
### 1. Shift+Hold Eraser Toggle
- **Behavior:** Pressing and holding the `Shift` key should temporarily switch the active tool to the Eraser (or Lasso Eraser, whichever is currently the default). Releasing the `Shift` key should revert to the previously selected tool (e.g., Pen, Line).
- **Implementation:** 
  - Track a `previousTool` ref or state.
  - Add `keydown` and `keyup` event listeners to the window/document. 
  - If `e.key === 'Shift'` and the user is in Markup mode, swap the tool. (Ensure this doesn't conflict with text input).

### 2. Lasso Eraser
- **Behavior:** The user can draw a closed loop, and everything inside that loop will be erased.
- **Implementation:**
  - Add a `"lasso-erase"` tool type. 
  - Update the Eraser button in the toolbar to be a split button or dropdown, allowing the user to toggle between "Stroke Eraser" (the existing one) and "Lasso Eraser". Make Lasso the default.
  - When drawing with `"lasso-erase"`, record it as a continuous freehand stroke.
  - In the stroke rendering loop, if `type === "lasso-erase"`, set `context.globalCompositeOperation = "destination-out"`, trace the path of the stroke, and use `context.fill()` to erase the entire area enclosed by the loop. (Optionally, also use `context.stroke()` to erase the edge smoothly).
  - *UX consideration:* While drawing the lasso, it might be helpful to draw a faint dashed line or outline so the user sees the area they are selecting, but since it's `destination-out`, it will just erase as they draw and fill on completion/render.

### 3. Text Tool
- **Behavior:** The user selects the "Text" tool, clicks anywhere on the image, and types text.
- **Implementation:**
  - Add a `"text"` tool to the toolbar.
  - When the user clicks the canvas with the text tool, spawn an HTML `<input>` or `<textarea>` positioned absolutely at the clicked coordinate. 
  - When the user hits `Enter` or clicks away (blur), save the text as a new stroke: `{ type: "text", text: "...", points: [{ x, y, width }], color }`.
  - Update the canvas rendering loop: if `type === "text"`, use `context.font` (scaled appropriately based on `stroke.points[0].width` or a text size setting) and `context.fillText(stroke.text, x, y)` to render the text onto the image.

## Execution Order
1. Implement the `Shift` key toggle logic for quick eraser access.
2. Build the Lasso Eraser logic and update the Eraser toolbar button to a split/dropdown control.
3. Build the Text tool, including the floating text input overlay and the canvas `fillText` rendering logic.
