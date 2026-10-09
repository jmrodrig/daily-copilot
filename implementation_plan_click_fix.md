# Implementation Plan: Fix Local Link Click Handling

## Branch
Continue on branch `feat/local-files`.

## Root Cause
When viewing a note in `NotePage.tsx` (the standard read-only note view):
1. The markdown renderer maps links to `<a>` tags but has **NO `onClick` handler** for local file links (`isLocalHref(href)`).
2. Because it renders `<a href="O:\Lawrences Files" target="_blank">`, modern web browsers automatically block opening local/file protocols from an HTTP webpage (`Not allowed to load local resource`). As a result, clicking the link silently does nothing at all.
3. In `NoteEditor.tsx`, reference pills (`referencePill.tsx`) only had `onDoubleClick={open}`, so single-clicking the pill in the editor also did not trigger opening.

---

## 1. Changes Needed

### A. `desktop/src/pages/NotePage.tsx`
1. Import `isLocalHref, openLocalFile` from `../lib/localFiles`.
2. In `markdownComponents.a`:
   - Check if `isLocalHref(props.href)`.
   - If `isLocalHref(props.href)` is true:
     - Render an anchor/button with `onClick={(e) => { e.preventDefault(); void openLocalFile(props.href!); }}`.
     - Ensure it displays with the pill styling and folder icon (`<PillIcon kind="url" href={props.href} />`).
     - This applies both when `kind === "url"` (saved with `ref:url`) AND when it is a standard markdown link `[name](<path>)`.

### B. `desktop/src/components/referencePill.tsx`
1. In `PillView`:
   - For `kind === "url"` where `isLocalHref(href)` is true:
     - Add `onClick={(e) => { e.preventDefault(); e.stopPropagation(); void openLocalFile(href); }}` so a single click immediately opens the local file/shortcut, rather than requiring an unintuitive double-click.

### C. `desktop/src/components/NoteEditor.tsx`
1. In `BubbleMenuWrapper`'s click listener:
   - Ensure clicks on local links or `[data-reference-pill]` with local paths prevent default and invoke `openLocalFile(href)`.

---

## 2. Verification
1. Run `npm run typecheck` in `desktop/`.
2. Verify in `NotePage.tsx` and `referencePill.tsx` that any click on a local link calls `openLocalFile`.
