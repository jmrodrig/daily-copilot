# Implementation Plan: Phase 9.8 - Media Resizing & Snap Grid
**Task ID:** phase-9.8

## Goal
Enhance image handling in the editor to mimic Confluence's layout mechanics: images must default to full page width and be centered, feature drag-handles for resizing, and snap to a visual layout grid during resizing.

## Scope
### 1. Resizable Image Node (`desktop/src/components/NoteEditor.tsx`)
- **Custom Node View:** Replace the default `@tiptap/extension-image` with a custom React NodeView (or an extended image extension) that wraps the `<img>` tag in a resizable container.
- **Drag Handles:** Render left and right drag handles on the image when it is selected.
- **Default State:** When a new image is pasted or inserted, its node attributes should default to `width: 100%` and it should be centered.

### 2. Snap Grid Visualization
- **Layout Grid:** Create a layout grid overlay (e.g., vertical lines dividing the page into standard layout columns like 25%, 50%, 75%, 100%).
- **Interaction:** 
  - The grid should appear/fade in while the user is actively dragging the image resize handles.
  - The dragging logic should calculate the nearest grid line and "snap" the image width to that percentage (e.g., snapped to 50% width).

### 3. Markdown Serialization (`desktop/src/components/noteFormatting.ts`)
- **The Challenge:** Standard Markdown `![alt](url)` does not store sizing or alignment.
- **The Solution:** Update the markdown serialization for the `Image` node. 
  - If the image is at 100% width and centered (the default), serializing as standard `![alt](url)` is fine, provided the read-only CSS defaults images to `width: 100%; margin: 0 auto`.
  - If the user resizes the image (e.g., to 50%), serialize it as an HTML tag: `<img src="..." alt="..." width="50%" style="display: block; margin: 0 auto" />`.
  - Ensure the `markdownTokenizer` and `NOTE_HTML_SCHEMA` are updated to read back `<img>` tags and their `width` attributes so the sizing survives a save/reload round-trip.

## Execution Order
1. Build the custom React NodeView for images featuring drag handles and width state.
2. Implement the grid overlay CSS/logic that triggers during a drag event.
3. Update `noteFormatting.ts` to serialize resized images into HTML `<img>` tags and parse them back securely.
4. Ensure the read-only `NotePage.tsx` CSS centers images and respects the custom widths.
