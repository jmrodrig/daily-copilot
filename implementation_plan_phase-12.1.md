# Implementation Plan: Phase 12.1 - Annotations Engine

## 1. Overview
This phase introduces the **Annotations Engine**, enabling non-destructive vector markup on both images and PDFs, alongside spatial sticky-note comments.

## 2. Architectural Changes

### 2.1 PDF Rendering (`pdf.js`)
- **Dependency:** Add `pdfjs-dist` to `desktop/package.json`.
- **Component:** Abstract the core drawing logic in `desktop/src/components/ImageLightbox.tsx` to support multiple media backends (Image and PDF).
- **Implementation:** Use `pdfjsLib.getDocument(url).promise` to fetch the PDF and `page.render({ canvasContext })` to render it onto a background canvas layer. The existing markup canvas will sit transparently on top of this PDF layer.

### 2.2 Sidecar Storage (Non-Destructive Markup)
- **Data Model:** Annotations will be saved as JSON sidecar files alongside the original media (e.g., `diagram.png` -> `diagram.png.json`).
- **Backend:** Create a new route `PUT /api/content/media/markup` (or similar, depending on the exact media pathing) that accepts a JSON payload of `strokes` and `comments` and saves it as a `.json` file on disk. Add a `GET` route to retrieve it.
- **Frontend Refactor:** Remove the current "burn-in" save logic in `ImageLightbox.tsx` (`context.drawImage(...)`). Instead, `save()` will serialize the `strokes` and `comments` arrays and `PUT` them to the backend. On component mount, it will `GET` the sidecar JSON and hydrate the drawing state.

### 2.3 Spatial Comments UI
- **Tooling:** Add a new "Comment" tool to the Lightbox toolbar.
- **Data Structure:** Extend the markup state to include a `comments` array: `{ id, x, y, text, isExpanded }`.
- **UI Component:** Render an absolute-positioned HTML overlay container exactly synced with the `zoom` and `pan` transformations of the canvas. 
- **Behavior:**
  - When the Comment tool is active, clicking the canvas creates a new comment at `(x, y)`.
  - The comment renders as a floating "sticky note" (textarea + save button).
  - Once saved, it collapses into a discrete comment icon. Clicking the icon re-expands the sticky note.

## 3. Scope of Work (for Claude Code)
1. Add `pdfjs-dist` to dependencies and configure Vite if necessary to support the pdf.js worker.
2. Update backend Python routes in `main.py` (or router) to support saving and loading `.json` sidecars for media files.
3. Refactor `ImageLightbox.tsx` into a generalized `MediaLightbox.tsx` (or expand it) to support PDF rendering.
4. Implement the Sidecar loading/saving logic replacing the canvas merge.
5. Implement the Spatial Comments overlay and state management.

## 4. User-Driven Manual Testing Strategy
**The User MUST execute the following steps before this branch can be merged to `main`:**

1. **Test Sidecar Image Migration:**
   - Open a Note. Upload a fresh Image.
   - Click "Edit / Markup". Draw a red arrow and save.
   - Close the image, refresh the page, and reopen the image markup.
   - Use the Eraser tool to delete the red arrow. (If it erases cleanly without destroying the image background, sidecar storage is working).
2. **Test PDF Rendering:**
   - Upload a `.pdf` file to the note.
   - Click the PDF pill/thumbnail to launch the Lightbox.
   - Verify the PDF renders cleanly. Draw on it and save. Reopen and verify the strokes persist.
3. **Test Spatial Comments:**
   - With the Lightbox open on any media, select the new "Comment" tool.
   - Click a specific location on the canvas. Type "Needs review" in the sticky note and save.
   - Verify it collapses into a small icon.
   - Click the icon to verify it expands back into a readable sticky note.
   - Pan and zoom the image to verify the comment pin stays anchored to the correct spatial coordinates on the image.

## 5. Branching Strategy
- **Branch Name:** `phase-12.1`
- **Target:** Branch off `main`. Do not merge until manual testing is verified.
