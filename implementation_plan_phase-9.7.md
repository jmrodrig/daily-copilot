# Implementation Plan: Phase 9.7 - Table Cell Colors
**Task ID:** phase-9.7

## Goal
Add a background color picker to the table floating menu in the Tiptap editor, allowing the user to tint table cells (e.g., coloring a cell red or green) exactly like Confluence.

## Scope
### 1. Editor Extension (`desktop/src/components/NoteEditor.tsx`)
- Extend the Tiptap `TableCell` and `TableHeader` extensions to support a `backgroundColor` attribute.
- In the floating "TABLE" menu (which appears when the cursor is inside a table), add a background color picker icon/button (similar to the text color "A" picker, perhaps a paint bucket or a grid icon).
- When a color is selected, call `editor.chain().focus().setCellAttribute('backgroundColor', color).run()`.

### 2. Markdown Serialization (CRITICAL)
- **The Challenge:** Standard GFM Markdown tables do not support cell-level attributes like background color. If you try to save a table with colored cells using default GFM, the colors will be silently dropped.
- **The Solution:** Update `desktop/src/components/noteFormatting.ts` to handle table cell colors. You have two options:
  - *Option A (Preferred for true cell colors):* Override the markdown serialization of tables to output raw HTML `<table>...</table>` when background colors are present, and ensure the HTML parser can read them back.
  - *Option B (Inline span hack):* Inject an inline `<span style="background-color: ...">` inside the markdown cell content. If doing this, try to make the `<span>` fill the cell padding using CSS (e.g. `display: block; margin: -...`), or intercept the span during parsing to apply its color to the parent `TableCell` node.
- Ensure `desktop/src/pages/NotePage.tsx` and the `NOTE_HTML_SCHEMA` sanitizer in `noteFormatting.ts` are updated to allow `style="background-color: ..."` on the relevant elements (`td`, `th`, or `span`), so the read-only view correctly renders the cell colors.

## Execution Order
1. Extend `TableCell` and `TableHeader` in the editor to accept `backgroundColor`.
2. Add the UI color picker to the floating Table menu in `NoteEditor.tsx`.
3. Implement the markdown serialization workaround in `noteFormatting.ts` so the colors survive a save/reload round-trip.
4. Update `NOTE_HTML_SCHEMA` to prevent the sanitizer from stripping the background color styles.
