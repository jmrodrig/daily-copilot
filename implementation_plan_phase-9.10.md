# Implementation Plan: Phase 9.10 - Image Lightbox & Stylus Markup
**Task ID:** phase-9.10

## Goal
Implement a fullscreen image lightbox (triggered by double-click or an expand icon) for both Draft and Published modes. In Draft mode, allow users to enter a "Markup" mode to draw on the image using a stylus, while supporting touch panning and zooming.

## Scope
### 1. Lightbox UI (`desktop/src/components/ImageLightbox.tsx`)
- Create a new fullscreen modal component that takes an `imageUrl`.
- **Header:** Display image metadata (if available) on the left. On the right, include an "Edit / Markup" button (only visible if the note is editable), a Download button, and a Close button.
- **Footer:** Add Zoom In/Out controls and a zoom percentage display (e.g., 100%).
- **Viewing Mode:** Render the image centered. It should support panning (dragging) and zooming.

### 2. Stylus Markup Canvas
- When the "Markup" button is clicked, overlay an HTML5 `<canvas>` exactly over the image.
- **Event Handling:**
  - Utilize `PointerEvents`.
  - If `pointerType === 'pen'` or `pointerType === 'mouse'` (depending on selected tool), draw lines on the canvas.
  - If `pointerType === 'touch'`, handle canvas panning (single finger) and pinch-zooming (two fingers).
- **Saving:** When the user clicks "Save" or exits markup mode, convert the combined original image and canvas drawings into a new blob (`canvas.toBlob()`), upload it using the existing `POST /api/notes/image` endpoint, and update the Tiptap node to point to the new image URL.

### 3. Editor Integration
- **Draft Mode (`NoteEditor.tsx` / `ResizableImage`):**
  - Add a hover state to images displaying an "Expand" icon in the top right corner.
  - Add a double-click event listener to the image node that opens the Lightbox.
  - Pass a callback to the Lightbox that allows it to update the node's `src` if a markup is saved.
- **Published Mode (`NotePage.tsx`):**
  - Update the `react-markdown` components mapping so that `<img>` tags are wrapped in a container with the same hover Expand icon.
  - Clicking the image in Published mode should open the Lightbox in read-only mode (no Markup button).

## Execution Order
1. Build the basic `ImageLightbox` modal with viewing, zooming, and panning capabilities.
2. Update the Draft editor (`ResizableImage`) and Published viewer to trigger the Lightbox on double-click/expand click.
3. Implement the `MarkupCanvas` logic inside the Lightbox, carefully separating `pen` drawing events from `touch` pan/zoom events.
4. Wire up the save action to upload the newly generated marked-up image to the backend and update the document.
