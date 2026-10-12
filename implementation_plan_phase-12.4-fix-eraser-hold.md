# Implementation Plan: Right-Click and Hold Eraser (`phase-12.4-fix-eraser-hold`)

## Branch
`phase-12.4-fix-eraser-hold` (branched off `main`)

---

## 1. Objective
Fix the right-click eraser behavior in the markup/annotation/whiteboard engine (`WhiteboardView.tsx`, `MediaLightbox.tsx`, and `markupUi.tsx`) so that **holding right-click** temporarily selects and activates the eraser tool while the right mouse button is held down, and **releasing right-click** automatically restores whatever tool was previously selected (instead of requiring a second right-click to toggle back).

---

## 2. Target Files & Detailed Changes

### A. `desktop/src/components/WhiteboardView.tsx`
1. **Track Temporary Right-Click Hold State**:
   - Replace toggle-style `previousToolRef` usage with hold-based state tracking (e.g., `previousToolRef = useRef<{ pointerId: number; tool: Tool } | null>(null)` or `Tool | null`).
   - Clear `previousToolRef.current = null` inside `pickTool` when a user explicitly selects a tool via toolbar or shortcut.
2. **Press-and-Hold on Right-Click (`rightDown`)**:
   - In `rightDown(e: ReactPointerEvent)`:
     - Guard: `if (!editable || spaceHeld || dragging()) return;`
     - Commit any active text (`commitText()`), close `eraserMenu` if open.
     - Determine active eraser: `const activeEraser = isEraser(tool) ? tool : eraserRef.current;`
     - If `!isEraser(tool)`:
       - Save `previousToolRef.current = { pointerId: e.pointerId, tool };`
       - Switch tool to `activeEraser` (`setTool(activeEraser)`).
     - Obtain `const point = worldPoint(e);` and if present, call `eraseDown(activeEraser, point, e.pointerId);`.
3. **Restore Previous Tool on Right-Click Release (`pointerUp` / `pointerCancel`)**:
   - Create a helper `releaseRightEraser(pointerId: number)` that checks if `previousToolRef.current?.pointerId === pointerId`:
     - Clears `previousToolRef.current = null`.
     - If `isEraser(toolRef.current)`, restores `setTool(savedTool)`.
   - Ensure `releaseRightEraser(e.pointerId)` runs on `pointerUp` (and `pointerCancel`) regardless of which branch completes (`erasing.current`, `selecting.current` with `< 3` points, `selecting.current` with `>= 3` points, or early exit).

### B. `desktop/src/components/MediaLightbox.tsx`
1. **Track Temporary Right-Click Hold State**:
   - Use `previousToolRef = useRef<{ pointerId: number; tool: Tool } | null>(null)`.
2. **Press-and-Hold on Right-Click (`rightDown`)**:
   - In `rightDown(e: ReactPointerEvent)`:
     - Guard: `if (!editing || drawing.current || erasing.current || selecting.current || transforming.current) return;`
     - Call `commitText()` and `setEraserMenu(false)`.
     - Determine active eraser: `const activeEraser = isEraser(tool) ? tool : eraserRef.current;`
     - If `!isEraser(tool)`:
       - Save `previousToolRef.current = { pointerId: e.pointerId, tool };`
       - Call `setTool(activeEraser)`.
     - Obtain `const point = imagePoint(e);` and if present, call `eraseDown(activeEraser, point, e.pointerId);`.
3. **Restore Previous Tool on Right-Click Release (`pointerUp` / `pointerCancel`)**:
   - Ensure that when `pointerUp(e)` (or `onPointerCancel`) fires for `e.pointerId`, after completing any active `erasing.current` or `selecting.current` operation, if `previousToolRef.current?.pointerId === e.pointerId`, it restores `setTool(previousToolRef.current.tool)` (when `isEraser(toolRef.current)`) and resets `previousToolRef.current = null`.

### C. `desktop/src/components/markupUi.tsx`
1. **Tooltip Update**:
   - Update the eraser `Segment` label from `${t.label} (or right-click)` to `${t.label} (or hold right-click)` so the UI hint accurately describes the press-and-hold behavior.

### D. `desktop/tests/whiteboard.spec.ts`
1. **Automated Playwright Test**:
   - Add verification that holding the right mouse button (`button: "right"`) while another tool (e.g. Pen or Rectangle) is active switches to the eraser, erases strokes when dragged, and automatically reverts back to the previous tool as soon as the right mouse button is released.

---

## 3. Automated QA & Verification Steps
1. Run Frontend TypeScript check in `desktop/`:
   - `npm run build` (or `npx tsc --noEmit`)
2. Run Playwright Whiteboard tests in `desktop/`:
   - `npx playwright test tests/whiteboard.spec.ts`

---

## 4. User-Driven Manual Testing Plan
To verify this feature hands-on before merging:
1. Launch the application (`start.cmd` or backend + `npm run dev` in `desktop`).
2. **Whiteboard Verification**:
   - Open an existing Whiteboard note (or a note with an embedded whiteboard block) in **Draft** mode.
   - Select the **Pen** tool (or **Rectangle** / **Select** tool) and draw a few strokes on the canvas.
   - **Click and hold the right mouse button** on the canvas:
     - Verify the toolbar highlights the **Eraser** tool while the right mouse button is held down, and no browser context menu appears.
     - While still holding the right mouse button, drag across/around a stroke to erase it (using either Lasso eraser or Stroke eraser).
   - **Release the right mouse button**:
     - Verify the stroke is erased AND the toolbar immediately switches back to the previously selected tool (e.g., Pen).
     - Left-click and drag to confirm you are immediately drawing again with the previous tool without needing to right-click a second time.
3. **Media Lightbox (Image/PDF Markup) Verification**:
   - Click on an attached image or PDF in a note to open the **Media Lightbox**, then click **Edit / Markup**.
   - Draw a stroke with the **Pen** tool.
   - **Right-click, hold, and drag** to erase the stroke, then **release the right mouse button**.
   - Verify the stroke is erased and the active tool immediately returns to the **Pen** tool upon release.
