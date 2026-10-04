# Implementation Plan: Phase 9.6 - Editor Alignment & Color Tools
**Task ID:** phase-9.6

## Goal
Enhance the Tiptap editor by adding Text Alignment and Text Color controls to the sticky toolbar, matching the Confluence mockup specs. 

## Scope
### 1. Dependencies
- Install the required Tiptap extensions: 
  - `@tiptap/extension-text-align`
  - `@tiptap/extension-color`
  - `@tiptap/extension-text-style` (required by color)

### 2. Toolbar Enhancements (`desktop/src/components/NoteEditor.tsx`)
- **Text Alignment:** 
  - Register `TextAlign.configure({ types: ['heading', 'paragraph'] })`.
  - Add icons/buttons to the toolbar for Align Left, Align Center, and Align Right.
- **Text Color:**
  - Register `Color` and `TextStyle`.
  - Add a color picker control to the toolbar. An `<input type="color" />` element styled neatly (or a small popover with predefined swatches) works best. It should call `editor.chain().focus().setColor(e.target.value).run()`.

### 3. Markdown Serialization (CRITICAL)
- Standard Markdown does not have syntax for text color or alignment.
- The `tiptap-markdown` extension (if used) must be configured to output HTML for these properties. Usually, configuring `html: true` on the markdown extension allows it to serialize unsupported formatting as inline HTML tags (e.g., `<p style="text-align: center">` or `<span style="color: #ff0000">`).
- Make sure that when the note is saved and reloaded, the HTML tags correctly parse back into the Tiptap editor with their alignment and color preserved, AND that the read-only `react-markdown` viewer securely allows and renders these style attributes (you may need `rehype-raw` installed for `react-markdown` to parse inline HTML styles).

## Execution Order
1. Install new dependencies (`npm install @tiptap/extension-text-align @tiptap/extension-color @tiptap/extension-text-style rehype-raw`).
2. Update `NoteEditor.tsx` to include the extensions and the new toolbar buttons.
3. Update `NotePage.tsx` to include `rehype-raw` in the `<Markdown>` component so read-only views render the alignment and color correctly.
4. Test the markdown serialization round-trip to ensure styles are saved and loaded perfectly.
