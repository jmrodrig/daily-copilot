# Implementation Plan: Whiteboard Locked Layers & Defaults

## Branch
Use branch `feat/whiteboard`

## 1. Default Color
**File:** `desktop/src/components/WhiteboardView.tsx`
- The user requested the default pen color to be white, since the background is dark.
- Update the initial `ink` state to default to White: `useState(INKS.find(i => i.name === "White")?.value ?? INKS[5].value)`.

## 2. Locked Layers Schema
**File:** `desktop/src/components/whiteboard.ts`
- Define `LockedLayer` type: `{ id: string, name: string, elements: FloatingElement[], strokes: Stroke[] }`.
- Add `lockedLayers?: LockedLayer[]` to both `WhiteboardState` and `WhiteboardDoc`.
- Update `parseWhiteboard` to properly deserialize `raw.lockedLayers`. Make sure the elements and strokes inside each layer are correctly reconstructed, just like the main elements and strokes.
- Update `serializeWhiteboard` to include `lockedLayers`.

## 3. Lock Action
**File:** `desktop/src/components/WhiteboardView.tsx`
- In `ElementToolbar`, add a new `Segment` button for "Lock to background". You can use an SVG padlock icon (e.g. `M4 6V4.5C4 2.6 5.6 1 7.5 1S11 2.6 11 4.5V6h1v8H3V6h1zm1-1.5C5 3.1 5.9 2 7.5 2S10 3.1 10 4.5V6H5V4.5z`).
- Add an `onLock` prop to `ElementToolbar` (or pass it a unified handler).
- When `onLock` is called:
  - Generate a new ID and a name like `Locked Layer ${doc.lockedLayers?.length ? doc.lockedLayers.length + 1 : 1}`.
  - Create the layer with the currently selected strokes and selected elements.
  - Remove those items from `doc.strokes` and `doc.elements`.
  - Append the new layer to `doc.lockedLayers`.
  - Clear the selection (`setSelected(new Set())`, `setSelectedElements(new Set())`).

## 4. Rendering Locked Items
**File:** `desktop/src/components/WhiteboardView.tsx`
- **Strokes:** In `redraw`, iterate through `doc.lockedLayers` and call `drawStrokes(context, layer.strokes)` *before* drawing `doc.strokes`.
- **Elements:** In the JSX return, map over `doc.lockedLayers`, and render their elements *before* `stacked.map` (the active elements). This puts them visually behind active elements.
- Because locked items are removed from `doc.strokes` and `doc.elements`, the existing pointer hit-testing and lasso logic will gracefully ignore them, making them completely unselectable.

## 5. Unlocking UI
**File:** `desktop/src/components/WhiteboardView.tsx`
- In the main top-left toolbar, if `doc.lockedLayers?.length > 0`, display a "Locked Layers" button (next to the markup tools or zoom controls).
- Clicking this button should open a dropdown menu (using the `Popover` component imported from `./Popover`).
- The popover should list all locked layers. For each layer, show its `name` and an "Unlock" button.
- When "Unlock" is clicked:
  - Remove the layer from `doc.lockedLayers`.
  - Append its `strokes` to `doc.strokes` and its `elements` to `doc.elements`.
  - Automatically select the newly unlocked items so the user clearly sees what they just recovered.
