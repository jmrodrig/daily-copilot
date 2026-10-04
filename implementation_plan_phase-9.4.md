# Implementation Plan: Phase 9.4 - Note Editor & Layout Overhaul
**Task ID:** phase-9.4

## Goal
Overhaul the Note Page layout and editor to closely resemble Confluence. Introduce a centered, max-width layout, clean up the metadata header, and replace the raw `<textarea>` with a rendered, rich-text WYSIWYG editor featuring a sticky formatting toolbar.

## Scope
### 1. Page Layout & Header Cleanup
- **Layout:** Center the note's content column on the page (e.g., using `max-w-4xl mx-auto`) so it doesn't span the entire width of the screen.
- **Metadata Display:**
  - Remove the `priority` field from the note's frontmatter display (as priorities belong to tasks, not notes).
  - Format the `created` timestamp to remove the "T" and the seconds (e.g., change `2026-10-02T22:46:19` to `2026-10-02 22:46`).
- **Save Indicator:** Change the "Saved" indicator from looking like a button to being a simple, unobtrusive text label/span next to the Publish button.

### 2. WYSIWYG Editor
- **Replace Textarea:** Completely remove the raw HTML `<textarea>` used for the draft state. Remove its bounding box.
- **Rich Text Integration:** Install a robust React WYSIWYG editor capable of interacting with Markdown (e.g., `tiptap` with markdown support, `@uiw/react-md-editor`, or a similar library that allows editing *rendered* text instead of raw markdown syntax).
- **Toolbar:** Add a sticky formatting toolbar above the editor containing standard controls:
  - Text formatting (Bold, Italic, Strikethrough)
  - Lists (Bullet, Numbered, Checklist)
  - Tables
- **Seamless Title:** Ensure the H1 (Title) feels like part of the page document flow, similar to Confluence.

## Execution Order
1. Update `NotePage.tsx` metadata and save indicator layouts.
2. Wrap the layout in a centered container.
3. Install necessary editor dependencies via `npm`.
4. Implement the WYSIWYG editor and toolbar.
5. Ensure the new editor correctly synchronizes its markdown output back to the backend `PUT /api/notes/file` endpoint when saving.
