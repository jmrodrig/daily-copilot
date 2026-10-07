# Resolution Plan: Phase 12 UX Tweaks & Fixes

## 1. Overview
This plan addresses user feedback regarding the vector markup engine (MediaLightbox) introduced in Phase 12.1. The user found that the lasso select was too generous, erasers behaved like opaque masks instead of deleting objects, and the markup wasn't visible inline in the notes after closing the lightbox.

## 2. Issues & Solutions

### A. Strict Lasso Selection
- **Current Behavior:** `lassoed()` selects a stroke if >50% of its points are inside the loop.
- **Fix:** Update `lassoed()` in `desktop/src/components/MediaLightbox.tsx` so that it expects the stroke to be strictly inside the drawn boundary. Change the condition to require `100%` of points inside the loop (or a very high threshold like 95%). 

### B. Destructive Object Erasers
- **Current Behavior:** The Stroke Eraser and Lasso Eraser add new strokes of type `erase`/`lasso-erase` drawn with `destination-out`. This acts as an opaque clipping mask, which the user dislikes because it can be selected/moved and hides things underneath.
- **Fix (Object Eraser):** Refactor the erasers to permanently delete strokes from the `strokes` state.
  - **Stroke Eraser (`erase`):** Do not create an `erase` stroke. Instead, in `pointerMove`, check if the current pointer position intersects with any existing stroke (e.g., check if the pointer is within `lineWidth` distance of any point in the stroke). If it does, remove that stroke from the `strokes` array immediately.
  - **Lasso Eraser (`lasso-erase`):** Do not create a `lasso-erase` stroke. Let the user draw a lasso loop (reusing the `selecting.current` visual logic or similar). On `pointerUp`, completely remove any strokes that fall inside the lasso loop from the `strokes` array.
  - Remove all legacy `destination-out` rendering logic since erasers are now purely destructive actions on the state array.

### C. Inline Markup Rendering
- **Current Behavior:** `NoteImage` only renders the base `img` or `pdf`. The sidecar JSON strokes are only drawn when the Lightbox is open.
- **Fix:** 
  - Export the drawing helpers (`drawStrokes`, `strokesByPage`, `CommentPin` rendering logic, etc.) from `MediaLightbox.tsx` or a new `lib/markup.ts`.
  - Update `NoteImage` (in `NotePage.tsx` and `NoteEditor.tsx`) to fetch the sidecar `.json`.
  - If a sidecar exists, overlay a `<canvas>` element on top of the `<img>` and execute `drawStrokes` to render the vectors inline. (Also render any `CommentPin` icons at their correct scaled coordinates so the user can see them without opening the lightbox).

## 3. Scope of Work (for Claude Code)
1. Update `lassoed()` logic in `MediaLightbox.tsx`.
2. Refactor `pointerDown`, `pointerMove`, and `pointerUp` in `MediaLightbox.tsx` to handle `erase` and `lasso-erase` destructively (removing objects from state) instead of drawing mask strokes.
3. Remove `destination-out` rendering logic.
4. Export drawing logic and create an inline `MarkupOverlay` in `NoteImage` components to render the sidecar vectors and comment pins directly in the document.
5. Verify changes with `npm run build`.
