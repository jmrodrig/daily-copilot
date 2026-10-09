# Implementation Plan: Unified Selection for Whiteboard

## Goal
The whiteboard currently restricts selection to EITHER strokes OR a single floating element (picture/PDF). When lassoing both, it prioritizes strokes. We need to unify the selection system so users can lasso and interact with strokes and multiple pictures *simultaneously* as a single group.

## Branch
Use branch `feat/whiteboard`

## 1. Unify Selection State
**File:** `desktop/src/components/WhiteboardView.tsx`
- Refactor `selectedId: string | null` to `selectedElements: Set<string>`. 
- Ensure that clicking individual items or lassoing multiple items adds *both* strokes and elements to their respective selection Sets.
- When lassoing (`lassoing.points.length >= 3`), no longer conditionally drop element selection if strokes are found. Add ALL strokes and ALL elements caught in the lasso to the selection.

## 2. Combined Bounding Box
**File:** `desktop/src/components/markupCore.ts` & `WhiteboardView.tsx`
- Create a helper `function groupBox(strokes: Stroke[], elements: FloatingElement[]): Box` that computes the combined bounding box by merging `selectionBox(strokes)` with `elementBounds(e)` for all selected elements.
- The `transforming` ref (`useRef`) needs to track both `originalStrokes` and `originalElements` (as well as `currentStrokes` and `currentElements`).
- Delete `startElementDrag` and the separate `elementDrag` ref. `transforming` should handle EVERYTHING.

## 3. Transforming Mixed Groups
**File:** `desktop/src/components/markupCore.ts` & `WhiteboardView.tsx`
- Update the transform logic (move, scale, rotate) to map over BOTH `strokes` and `elements` at the same time around the combined `groupBox`.
- Moving: Add `dx` and `dy` to `element.x` and `element.y`.
- Scaling (corners): Apply the same anchor-based scale calculation to the element's `x`, `y`, `w`, `h`. (Scale the distance from the element's center to the anchor, and multiply width/height).
- Rotating: Add `angle` to `element.angle`. Rotate the element's center around the `groupBox` center to find its new `x` and `y`.

## 4. UI Rendering
**File:** `desktop/src/components/WhiteboardView.tsx`
- Remove the separate DOM-based selection box (the `div` with corner handles and a stalk) previously used for `selectedElement`.
- Instead, use the existing `drawSelection(context, groupBox(...))` on the `<canvas>` to draw the bounding box and handles for ALL selections (even if it's just one picture).
- Update the `ElementToolbar` (Bring Forward, Set Page, etc.) to appear near the `groupBox` if ANY element is selected. If multiple elements are selected, operations like "Delete" or "Bring Forward" should apply to all of them. (You can hide "Set Page" if multiple elements are selected).
