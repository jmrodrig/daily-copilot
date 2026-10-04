# Implementation Plan: Phase 9.5 - Editor Polish & Image Pasting
**Task ID:** phase-9.5

## Goal
Refine the Tiptap editor to precisely match the Confluence layout (editable inline title, sticky top toolbar), enable column resizing for tables, and support direct image pasting from the clipboard.

## Scope
### 1. Title & Toolbar Layout
- **Toolbar Position:** Move the Tiptap formatting toolbar so it sits sticky at the very top of the editor area (above the title and metadata), just like the Confluence mockup.
- **Editable Title:** 
  - The massive `32px` note title should be seamlessly editable when the note is in `DRAFT` state. 
  - Replace the static `<h1>` with an auto-resizing text `<input>` (or similar seamless editable element) styled to look exactly like the header. 
  - When the user edits the title and saves, it should update the note's frontmatter `title`. (Optional but recommended: update the underlying filename if it's safe to do so, or just rely on the frontmatter `title` for display).

### 2. Table Enhancements
- **Resizable Columns:** Configure the Tiptap `Table` extension with `resizable: true` to allow the user to drag and adjust column widths. Ensure the CSS supports the resize handles.
- **Table Controls:** Ensure the table cell context controls (Add Row, Add Column) are highly visible. If custom floating UI is too complex, ensure the toolbar buttons are clear and perhaps add a small helper text or visual indicator when inside a table.

### 3. Image Pasting
- **Backend (`backend/main.py` & `backend/file_layer.py`):**
  - Create a new endpoint `POST /api/notes/image` that accepts a `multipart/form-data` file upload.
  - The backend should save the image to a hidden assets folder within the current space (e.g., `data/spaces/<space_id>/content/.assets/<uuid>.png`).
  - Return the relative markdown URL (e.g., `{"url": "/api/notes/image/<uuid>"}` or similar so the frontend can render it, or directly serve static files from `.assets`).
- **Frontend (`desktop/src/components/NoteEditor.tsx`):**
  - Add an `editorProps.handlePaste` event listener to the Tiptap configuration.
  - When a user pastes image data (e.g., taking a screenshot and pressing Ctrl+V), intercept the `ClipboardEvent`.
  - Extract the `File` object, `POST` it to the new backend endpoint, and upon success, insert an `Image` node (or a markdown image string) into the editor at the cursor position.
  - *Note: Ensure `@tiptap/extension-image` is installed and configured if using Tiptap's Image node.*

## Execution Order
1. Implement the backend image upload endpoint and static file serving for images.
2. Install `@tiptap/extension-image` if not present.
3. Update `NoteEditor.tsx` to handle `onPaste` for images and insert them into the editor.
4. Restructure `NotePage.tsx` and `NoteEditor.tsx` to move the formatting toolbar to the top and make the Title a seamless editable input.
5. Enable `resizable: true` on the Table extension and add the required CSS for the resize handles.
