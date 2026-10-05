# Implementation Plan: Phase 9.17 - File Attachments
**Task ID:** phase-9.17

## Goal
Expand the existing image upload workflow to support attaching any file type (e.g., PDFs, documents). When a non-image file is dragged or pasted into a note, it should upload to the `.assets/` directory and insert a Markdown link (e.g., `[filename.pdf](/api/notes/image/uuid.pdf)`) into the editor.

## Scope
### 1. Backend Updates
- **`backend/file_layer.py`:**
  - Update `_ASSET_NAME_RE` to allow any alphanumeric extension (e.g., `\.[a-zA-Z0-9]{1,10}\Z`) instead of just image formats.
  - Modify `save_asset` to accept an optional `filename` string. If `content_type` is not in `IMAGE_SUFFIXES`, extract the extension from `filename` (defaulting to `.bin` if missing). Remove the strict exception for non-image types.
- **`backend/main.py`:**
  - In `upload_image` (which serves `POST /api/notes/image`), pass `file.filename` to `file_layer.save_asset`.
  - Increase `MAX_IMAGE_BYTES` (rename to `MAX_ASSET_BYTES`) to a larger size like 50MB (`50 * 1024 * 1024`) to accommodate PDFs and other documents.
  - The endpoints can remain named `/api/notes/image` to prevent breaking existing note content, but now they will serve and store any file type correctly.

### 2. Frontend Updates
- **`desktop/src/components/NoteEditor.tsx`:**
  - Remove the `imageFiles` filter logic that restricted `dataTransfer` and `clipboardData` to `image/*`. Create an `extractFiles` helper that captures all dropped/pasted files.
  - Update `uploadImage` (or rename to `uploadFile`) to return both the URL and the original filename (e.g., `{ url, name }`).
  - Update `insertImages` (rename to `insertFiles`) to check the file type.
    - If `file.type.startsWith("image/")`, create a `nodes.image` node as before.
    - If it's another file type, create a `text` node with the filename and apply a `link` mark pointing to the uploaded URL. (e.g. `view.state.schema.text(file.name, [view.state.schema.marks.link.create({ href: url })])`).
  - Update `handlePaste` and `handleDrop` to pass all files to `insertFiles`.

## Execution Order
1. Update `backend/file_layer.py` to lift file extension and regex restrictions.
2. Update `backend/main.py` upload route to pass filenames and increase the size limit.
3. Update `desktop/src/components/NoteEditor.tsx` to process all files and conditionally insert links vs image nodes.
