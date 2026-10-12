# Implementation Plan: Fix Chat-to-Note Copy & Paste (`chat-copy-paste`)

## 1. Root Cause Analysis

When the user copied formatted text from `CopilotChat.tsx` (either by selecting text with the mouse and pressing `Ctrl+C`, or by clicking the **Copy** button) and pasted (`Ctrl+V`) into `NoteEditor.tsx`, math formulas and formatting were corrupted (as observed directly in `backend/data/spaces/1/content/C44E AVVENTO.md`):

1. **Duplicate Math Output (`ML*ML*\u200b`, `BR*BR*`, `RM1∘*RM*1∘\u200b`, `I*I*`)**:
   - KaTeX (`rehype-katex`) renders each formula as `<span class="katex">` containing **two** parallel DOM subtrees:
     1. `<span class="katex-mathml"><math>...<annotation encoding="application/x-tex">M_L</annotation></math></span>` (visually clipped 1x1px for screen readers)
     2. `<span class="katex-html" aria-hidden="true">...</span>` (the visual layout spans, which end with a `\u200b` zero-width space inside `<span class="vlist-s">` and have `font-style: italic` on `.mathnormal` variables).
   - When the user copied from the chat (via mouse selection `Ctrl+C` or the `Copy` button) and pasted into `NoteEditor.tsx`:
     - `NoteEditor.tsx` had no Tiptap extension or HTML paste transform for `.katex` / math.
     - ProseMirror's `DOMParser` walked both `.katex-mathml` (`ML`, `RM1∘`, `I`) and `.katex-html` (`*ML*\u200b`, `*RM*1∘\u200b`, `*I*`), duplicating every formula into `ML*ML*\u200b`.
     - Furthermore, when serialized by `@tiptap/markdown` inside bold text (`**Lightship Displacement (ML*ML*\u200b):**`), the trailing `\u200b` zero-width space after `*ML*` broke CommonMark right-flanking emphasis rules in `NotePage.tsx`, leaving literal `*ML*` asterisks visible.
   - Additionally, when starting a mouse drag on the visible characters of a formula in the browser, `range.startContainer` lands inside `.katex-html` (after `.katex-mathml`), cutting off `.katex-mathml` and its `<annotation>` unless the selection range is expanded to the enclosing `.katex` element on copy.

2. **Missing Math Support in `NoteEditor.tsx` (Draft Mode) & `@tiptap/markdown` Escaping**:
   - `NoteEditor.tsx` lacked inline and block math extensions (`InlineMath` and `BlockMath`).
   - Even if `$M_L$` or `$RM_{1^\circ}$` was present in a note's Markdown, opening the note in `NoteEditor.tsx` (Draft mode) failed to render the math visually, and any edit in `NoteEditor.tsx` caused `@tiptap/markdown`'s `escapeMarkdownSyntax` to escape `_` and `\` into `$M\_L$` and `$RM\_{1\\circ}$`, breaking the formula upon saving.
   - Importantly, in `@tiptap/markdown`'s `renderNodesWithMarkBoundaries`, non-text inline nodes (`node.type !== "text"`) cause active marks like `bold` (`**`) to close before the node and reopen after it (`**Lightship Displacement (**$M_L$**):**`), or fail to open at the start of a bold run (`**$I$:**` -> `$I$**:**`). Modeling `InlineMath` as a Tiptap **Mark** (`code: true`, `priority: 50`) on text nodes keeps `node.type === "text"`, so `@tiptap/markdown` keeps outer `**...**` marks open (`**Lightship Displacement ($M_L$):**` and `**$I$:**`) while skipping `escapeMarkdownSyntax` on the LaTeX text, and a ProseMirror decoration plugin renders live KaTeX widgets inside the editor when the caret is outside the math span.

3. **Plain-Text Markdown Paste & Redundant Heading Bold**:
   - When pasting HTML from LLM output where headings are wrapped in `<strong>` (`<h3><strong>2. Displacement &amp; Stability</strong></h3>`), unwrapping redundant top-level `<strong>`/`<b>` inside `h1`–`h6` prevents `### **2. Displacement &amp; Stability**`.
   - When pasting `text/plain` Markdown (when no `text/html` is on the clipboard, or when copying raw Markdown), `NoteEditor.tsx` previously inserted raw unparsed text (escaping `#` and `*` into `\#` and `\*`) instead of parsing it via `editor.markdown.parse`.

---

## 2. Proposed Changes

### A. Math Extensions & Paste HTML Normalization (`desktop/src/components/noteFormatting.ts`)
1. **`InlineMath` Mark (`inlineMath`)**:
   - Define `InlineMath = Mark.create({ name: "inlineMath", priority: 50, code: true, excludes: "code", ... })`:
     - Setting `code: true` registers `"inlineMath"` in `@tiptap/markdown`'s `codeTypes` set so `encodeTextForMarkdown` returns the raw LaTeX text without escaping `_`, `\`, `^`, `{`, `}`, or `~`, and without encoding `&`.
     - Setting `priority: 50` (lower than `Bold`'s `100` and `Italic`'s `100`) ensures `InlineMath` (`$...$`)always nests inside `**...**` and `*...*` when serialized (`**$I$:**`, `**Lightship Displacement ($M_L$):**`).
     - `parseHTML`: matches `span[data-math-inline]`.
     - `renderHTML`: returns `["span", { class: "note-math-inline", "data-math-inline": "" }, 0]`.
     - `markdownTokenName: "inlineMath"`, `markdownTokenizer` (level: `"inline"`, matching `$...$` without leading/trailing space or newlines), `parseMarkdown` (`h.applyMark("inlineMath", [h.createTextNode(token.text ?? "")])`), and `renderMarkdown` (`` `$${h.renderChildren()}$` ``).
     - `addProseMirrorPlugins`: adds a ProseMirror decoration plugin that finds contiguous `inlineMath` mark ranges in the document. When the editor selection does not sit inside a range (`!(sel.from >= from && sel.to <= to)` or when blurred), it renders a `Decoration.widget(from, ...)` containing `katex.renderToString(latex, { throwOnError: false, output: "html" })` (clicking the widget places the caret inside the range to edit the LaTeX) and hides the raw text range with `Decoration.inline(from, to, { class: "note-math-source-hidden" })`.
2. **`BlockMath` Node (`blockMath`)**:
   - Define `BlockMath = Node.create({ name: "blockMath", group: "block", atom: true, ... })`:
     - Attribute `latex` (string).
     - `parseHTML`: matches `div[data-math-block]` and `span.katex-display`.
     - `renderHTML`: returns `["div", { class: "note-math-block", "data-math-block": latex }, `$$\n${latex}\n$$`]`.
     - `addNodeView`: renders a `<div class="note-math-block" contenteditable="false">` displaying `katex.renderToString(latex, { displayMode: true, throwOnError: false, output: "html" })`.
     - `markdownTokenName: "blockMath"`, `markdownTokenizer` (level: `"block"`, matching `$$\n?([\s\S]+?)\n?$$`), `parseMarkdown`, and `renderMarkdown` (`` `$$\n${latex}\n$$` ``).
3. **`cleanCopiedMathDom` & `transformNotePastedHTML` Helpers**:
   - Export `cleanMathForClipboard(root: ParentNode): void` and `selectionToClipboard(root: HTMLElement): { html: string; text: string } | null`:
     - In `selectionToClipboard`, clone the current `Range`; if `startContainer` or `endContainer` is inside `.katex-display` or `.katex`, expand the cloned range via `setStartBefore` / `setEndAfter` so the entire `.katex` element (including `<annotation encoding="application/x-tex">`) is captured.
     - Wrap the cloned fragment in any semantic block ancestors (`h1`–`h6`, `ul`, `ol`, `li`, `pre`, `code`, `blockquote`, `table`, `thead`, `tbody`, `tr`) between `commonAncestorContainer` and `root`.
     - For `html`: annotate `.katex-display` with `data-math-block="<tex>"` and `.katex` with `data-math-inline="<tex>"`, remove `.katex-html` (so external apps like Word/Docs only see MathML without duplicate text), and strip `\u200b`.
     - For `text`: replace `.katex-display` with `$$\n<tex>\n$$` and `.katex` with `$<tex>$`, and strip `\u200b`.
   - Export `transformNotePastedHTML(html: string): string`:
     - Parses `html` via `DOMParser`.
     - Replaces every `.katex-display` / `[data-math-block]` with `<div data-math-block="<tex>"></div>`.
     - Replaces every `.katex` / `[data-math-inline]` with `<span data-math-inline=""><tex></span>` (extracting `<tex>` from `data-math-inline`, `data-latex`, or `annotation[encoding="application/x-tex"]`).
     - Removes any orphaned `.katex-html` elements and strips `\u200b` zero-width spaces from text nodes.
     - Unwraps redundant `<strong>` / `<b>` that wrap the entire contents of `<h1>`–`<h6>` headings.

### B. Wire Math & Paste Handling into `NoteEditor.tsx` (`desktop/src/components/NoteEditor.tsx`)
1. Register `InlineMath` and `BlockMath` in `useEditor({ extensions: [...] })`.
2. Add `transformPastedHTML: (html) => transformNotePastedHTML(html)` in `editorProps`.
3. Update `handlePaste` in `editorProps`:
   - Keep existing file-upload paste handling first.
   - When pasting plain text with no `text/html` (e.g. raw Markdown or `Ctrl+Shift+V`) outside of code blocks/marks, if the pasted text contains Markdown block/inline constructs (headings, lists, tables, fenced code, math `$...$`, bold `**...**`, links), parse and insert it via `editor.commands.insertContent(text.replace(/\u200b/g, ""), { contentType: "markdown" })`.

### C. Clean Copy Handling in `CopilotChat.tsx` and `NotePage.tsx`
1. In `desktop/src/components/CopilotChat.tsx`:
   - Attach `onCopy` to `ChatMarkdown` (or the `.markdown` wrapper) calling `selectionToClipboard` so `Ctrl+C` selections in chat always put clean `text/html` and `text/plain` on the clipboard (without Chromium's computed styles or duplicate `.katex-html` text).
   - Update `copyReply` to clone `container`, run `cleanMathForClipboard(clone)`, and write both `text/html` (`clone.innerHTML`) and `text/plain` (`text`), falling back to `navigator.clipboard.writeText(text)` if `ClipboardItem` fails.
2. In `desktop/src/pages/NotePage.tsx`:
   - Attach the same `onCopy` handler to `<article className="note-body markdown ...">` so copying from a published note also copies clean math and HTML.

### D. Styling & Existing Note Cleanup (`desktop/src/index.css` & `C44E AVVENTO.md`)
1. In `desktop/src/index.css`:
   - Add `.note-math-source-hidden { font-size: 0; color: transparent; }` and `.note-math-inline-widget { cursor: pointer; }` so `InlineMath` decorations in `NoteEditor.tsx` display the rendered KaTeX widget seamlessly when the caret is outside the math span and reveal editable LaTeX source when the caret enters it.
2. In `backend/data/spaces/1/content/C44E AVVENTO.md`:
   - Restore the corrupted `ML*ML*​`, `BR*BR*`, `RM1∘*RM*1∘​`, `I*I*`, etc., to clean `$M_L$`, `$B_R$`, `$RM_{1^\circ}$`, `$RM_{30^\circ}$`, `$RM_{MAX}$`, `$I$`, `$J$`, `$P$`, `$E$`, `$BAS$`.

---

## 3. User-Driven Testing Plan

1. **Test Mouse-Selection Copy & Paste (`Ctrl+C` -> `Ctrl+V`) from Chat into a Note**:
   - Open the Co-Pilot chat and ask for the Spirit 44E Avvento parameters.
   - Select a couple of sections in the chat response (including headings, bullet lists, and math expressions like $M_L$, $B_R$, $RM_{1^\circ}$, $I$, $J$) with the mouse and press `Ctrl+C`.
   - Open a note in **Draft** mode (`NoteEditor`) and press `Ctrl+V`.
   - **Expected**:
     - Headings, bullet lists, nested lists, and bold labels paste cleanly.
     - Math formulas ($M_L$, $B_R$, $RM_{1^\circ}$, $I$, $J$) render as clean KaTeX math inside the draft editor with **no** duplicate text (`MLML`, `RM1∘RM1∘`, `II`) and **no** literal `*ML*` asterisks.
     - Click **Publish** to view the read-only note: verify all headings, lists, and math formulas render identically in Published mode.
     - Click **Edit** (Draft) again: verify the formulas remain intact and are not escaped on subsequent edits.

2. **Test the "Copy" Button (`Copy` -> `Ctrl+V`) from Chat into a Note**:
   - Click the **Copy** button at the bottom-right of an assistant response in the chat.
   - Paste (`Ctrl+V`) into a draft note.
   - **Expected**: The entire response pastes with full rich formatting and rendered KaTeX math.
