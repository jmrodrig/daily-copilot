# Implementation Plan: Excalidraw-Style Whiteboard

## Goal
Build a rich interactive Whiteboard canvas that supports freehand markup, diagrams, and floating, re-orderable images and PDFs. The whiteboard can be embedded inside a standard note as a widget, or act as a full standalone page.

## Branch
Use branch `feat/whiteboard`

## 1. Architecture & State Schema
The whiteboard state should be serialized as JSON.
```typescript
type FloatingElement = {
  id: string;
  kind: "image" | "pdf";
  src: string;
  page?: number; // for PDFs
  x: number; y: number; w: number; h: number;
  z: number;
};

type WhiteboardState = {
  grid: boolean;
  elements: FloatingElement[];
  markup: MediaMarkup; // Re-uses existing stroke/comment schema
};
```

## 2. Refactor Markup Engine (if necessary)
**File:** `desktop/src/components/MediaLightbox.tsx`
- The existing markup engine logic (tools, strokes, shapes, lasso selection) is tightly coupled to the lightbox.
- Refactor the generic drawing logic into shared utilities (e.g. `desktop/src/components/markupCore.ts`) so it can be reused by both `MediaLightbox` and the new Whiteboard, OR build the Whiteboard to natively share this logic. Ensure the same tools (Pen, Rectangle, Line, Arrow, Ellipse, Text, Select) work seamlessly.

## 3. Whiteboard View Component
**File:** `desktop/src/components/WhiteboardView.tsx`
- A responsive, pan/zoomable canvas.
- **Background**: Dark (`bg-surface-default`). Add a toggleable CSS blueprint grid.
- **Elements Layer**: Render `FloatingElement`s as DOM nodes (images or PDF pages via `pdf.js`) below the markup canvas.
- **Element Interaction**: 
  - Clicking an element with the `Select` tool highlights it.
  - Drag to move.
  - Corner handles to resize.
  - Provide a mini-toolbar for the selected element: "Bring Forward", "Send Backward", "Delete", and "Set Page" (for PDFs).
  - Provide an "Insert Media" button in the main toolbar to upload and drop a new Image/PDF onto the canvas.
- **Markup Layer**: The transparent `<canvas>` where strokes and diagrams are drawn over the elements.

## 4. Note Integration: Embedded Widget
**File:** `desktop/src/components/noteFormatting.ts` & `WhiteboardWidget.tsx`
- Create a Tiptap Node extension `WhiteboardBlock` that matches fenced code blocks with language `whiteboard`:
  ````markdown
  ```whiteboard
  {"grid": true, "elements": [], "markup": {"strokes": [], "comments": []}}
  ```
  ````
- Render it using `ReactNodeViewRenderer`.
- The widget should display the `WhiteboardView`. Edits to the canvas must call `updateAttributes` to persist the updated JSON back to the markdown document.

## 5. Note Integration: Standalone Page
**Files:** `desktop/src/pages/NotePage.tsx` and `desktop/src/components/NoteEditor.tsx`
- If a note's frontmatter contains `type: "whiteboard"`, bypass the standard Tiptap editor and Markdown rendering entirely.
- Render the `WhiteboardView` taking up the full height of the page.
- Its state is parsed from the raw `content` of the note (which will just be the JSON payload).
- Add an option to the sidebar's "New" menu (e.g., `onMenu` in `Sidebar.tsx`) to "New Whiteboard", which creates a `.md` file pre-filled with the frontmatter `type: whiteboard` and an empty whiteboard JSON payload.

## Verification
- Ensure the dev servers are STOPPED while making these heavy modifications to prevent file-lock crashes.
- Ensure `npm run typecheck` passes after the refactoring.
