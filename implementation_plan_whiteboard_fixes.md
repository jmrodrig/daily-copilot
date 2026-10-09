# Implementation Plan: Whiteboard Fixes

## Branch
Use branch `feat/whiteboard`

## 1. Fix Embedded Widget Drag-and-Drop Bug
**File:** `desktop/src/components/WhiteboardView.tsx`
- Add `draggable={false}` and `onDragStart={(e) => { e.preventDefault(); e.stopPropagation(); }}` to the root `<div role="application">` and to the panning container `<div className="relative min-h-0 flex-1 touch-none select-none ...">`.
- This strictly stops the browser or Tiptap from initiating a native drag-and-drop when the user clicks and holds to draw.

## 2. Lasso Selection for Pictures
**File:** `desktop/src/components/markupCore.ts`
- Export the `insideLoop` function (or add an exported `lassoedElement` function).
**File:** `desktop/src/components/WhiteboardView.tsx`
- In `pointerUp` where the lasso completes (`lassoing.points.length >= 3`):
  - Check if any floating elements' centers are inside the lasso loop.
  - If `lassoing.erase` is true: delete the lassoed elements and strokes.
  - If `lassoing.erase` is false: if strokes are lassoed, select them. If an element is also lassoed, we can set it as `selectedId` (if no strokes are lassoed, or prioritize the element). 

## 3. Rotate Picture
**File:** `desktop/src/components/whiteboard.ts`
- Add `angle?: number` to `FloatingElement`.
**File:** `desktop/src/components/WhiteboardView.tsx`
- In `pointerDown`, when testing for `selectionHandle` on the `selectedElement`, un-rotate the `point` by `-selectedElement.angle` around the element's center before calling `selectionHandle`, so the math correctly hits the rotated handles. 
- Change `selectionHandle`'s 4th parameter from `false` to `true` (or omit) so it returns `"rotate"` for the top rotation handle.
- Update `startElementDrag` signature to accept `"move" | Corner | "rotate"`.
- In `pointerMove`, handle `drag.handle === "rotate"` for elements by calculating the difference in `Math.atan2` from the element's center to `point` vs `drag.from`. Add this difference to `drag.original.angle`.
- In the element rendering and the selection frame rendering, add `transform: element.angle ? \`rotate(${element.angle}rad)\` : undefined`.

## 4. Fullscreen Mode for Standalone Page
**File:** `desktop/src/pages/NotePage.tsx` or `WhiteboardView.tsx`
- The user noticed the embedded widget has a fullscreen button, but the standalone page (`type: whiteboard`) doesn't.
- If it's rendered as a standalone page, add a "Fullscreen" button to the whiteboard toolbar (or just use the existing one if we pass a `onFullscreen` prop). 
- When clicked, use the browser's native `document.documentElement.requestFullscreen()` or add a fixed overlay mode. Alternatively, just ensure `WhiteboardView` can expand to the whole screen natively.
