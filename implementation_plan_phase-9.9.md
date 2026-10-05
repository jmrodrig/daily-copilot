# Implementation Plan: Phase 9.9 - Auto-save, Full-Width Layouts & Table Resizing
**Task ID:** phase-9.9

## Goal
Finalize the editor UX by implementing an auto-save mechanism, breaking the toolbar out to full canvas width, and allowing Images and Tables to resize beyond the text column up to the full viewport width.

## Scope
### 1. Full-Width Layout Architecture (`desktop/src/pages/NotePage.tsx` & `index.css`)
- **The Layout Shift:** Currently, the entire note body is constrained by `max-w-4xl`. Remove this constraint from the parent container so the editor area fills the canvas width (minus padding).
- **Text Constraining:** Update the CSS (for both the `.ProseMirror` editor and the `.markdown` read-only viewer) so that direct children like paragraphs, headings, and lists are constrained to `max-w-4xl mx-auto`.
- **Breakout Elements:** Images and Tables should *not* be constrained by the 4xl max-width. They should be allowed to grow up to 100% of the newly expanded canvas.
- **Full-Width Toolbar:** Because the parent container is now full canvas width, the sticky formatting toolbar will naturally span the entire width.

### 2. Table Overall Resizing
- The user wants to resize the *entire* table by dragging its right edge, mirroring the image resize behavior, and allowing it to expand past the text column boundaries.
- **Implementation:** Wrap the Tiptap Table in a resizable container (similar to the `ResizableImage` NodeView), or attach a custom right-edge drag handle to the table wrapper.
- Dragging this handle should adjust the overall width percentage of the table. Update the snap lines so they visualize the expanded canvas width (e.g., beyond the standard 100% text column).
- **Serialization:** Ensure the custom table width is saved securely in the markdown (e.g., as an HTML `<table>` with a width attribute, or an inline wrapper) and parsed back correctly.

### 3. Image Oversizing
- Update the image drag handles and snap lines to allow dragging past the text boundary, up to the edge of the canvas. 

### 4. Auto-Save Mechanism
- In `NotePage.tsx` or `NoteEditor.tsx`, implement a debounced auto-save.
- When the editor content or title changes (and `hasUnsavedChanges` is true), wait for a period of inactivity (e.g., 2000ms).
- If no new keystrokes occur, automatically trigger the save API and update the UI indicator to "Saved".
- Ensure the explicit "Save draft" button remains for manual triggering or immediate feedback, or cleanly transition it to a passive "Saving..." / "Saved" label entirely.

## Execution Order
1. Implement the CSS layout shift (full canvas width, constrained text blocks).
2. Upgrade the Table extension to support overall wrapper resizing via a right-edge drag handle.
3. Update the Snap Grid and Resize logic for both images and tables to allow "oversizing" up to 100% of the new canvas wrapper.
4. Implement the debounced auto-save hook in the NotePage/NoteEditor components.
