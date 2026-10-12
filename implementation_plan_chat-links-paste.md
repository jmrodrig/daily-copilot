# Implementation Plan: Active Clickable File Links After Chat Copy & Paste (`chat-links-paste`)

## 1. Root Cause Analysis

In the Co-Pilot chat (`CopilotChat.tsx`), the agent cites local and network files either as inline code spans (e.g. `` `\\SYFILEAPP1\Shared\Spirit 44E\44 001 Avvento\44E01 Documentation\Spirit 44E - Owner's Manual.pdf` ``) or as Markdown links (`[label](\\SYFILEAPP1\...)`).

In `CopilotChat.tsx` (`CHAT_MARKDOWN_COMPONENTS`), both are rendered as active clickable links that open the local file via `openLocalFile(path)`:
- `CHAT_MARKDOWN_COMPONENTS.a` intercepts `isLocalHref(href)` and calls `openLocalFile(href)`.
- `CHAT_MARKDOWN_COMPONENTS.code` checks if an inline `<code>` span's text satisfies `isLocalHref(text)` and renders it with `role="link"`, `tabIndex={0}`, `title="Open ..."`, `className="cursor-pointer hover:border-accent hover:text-accent"`, and `onClick={() => void openLocalFile(text)}`.

However, when the user copies a chat response and pastes it into a note (`NoteEditor.tsx` -> saved to `.md` -> rendered in `NotePage.tsx`), those file references are **not** active clickable links in the note for three reasons:

1. **Missing `code` Renderer in `NotePage.tsx` (`NOTE_COMPONENTS`)**:
   - In `desktop/src/pages/NotePage.tsx`, `NOTE_COMPONENTS` only defines `img`, `pre`, and `a`—it does **not** define `code`.
   - As a result, in a published note (such as `C44E AVVENTO.md`), inline `<code>` file references (`\\SYFILEAPP1\...`, `C:\...`, `file:...`) render as inert static `<code>` spans with no hover styling and no click handler.
2. **Missing Local-Path Inline `<code>` Interactivity in `NoteEditor.tsx` (Draft Mode)**:
   - In `desktop/src/components/NoteEditor.tsx`, `BubbleMenuWrapper`'s click listener on `editor.view.dom` only handles clicks on `[data-reference-pill][data-kind="url"]` and `a[href]`. It ignores clicks on inline `<code>` elements whose text is a local path (`isLocalHref(text)`).
   - Furthermore, inline `<code>` marks holding a local path in `NoteEditor.tsx` lack the `cursor-pointer hover:border-accent hover:text-accent` styling and `title="Open ..."` tooltip, so they look and behave like dead text in Draft mode.
3. **UNC Backslash Unescaping in `NoteLink.renderMarkdown` (`NoteEditor.tsx`)**:
   - When a link `<a href="\\SYFILEAPP1\Shared\...">` is pasted into `NoteEditor.tsx` and serialized to Markdown by `NoteLink.renderMarkdown`, it writes `[label](<\\SYFILEAPP1\Shared\...>)`.
   - In CommonMark (`marked` and `react-markdown`), `\` inside `<...>` or `(...)` link destinations escapes ASCII punctuation, so the leading `\\` is unescaped to a single backslash `\SYFILEAPP1\Shared\...`, causing `isLocalHref` (which requires `\\\\`) to return `false` when the note is published or reloaded.

---

## 2. Proposed Changes

### A. Make Inline `<code>` Local File Paths Clickable in `NotePage.tsx` (`desktop/src/pages/NotePage.tsx`)
1. Add `code` to `NOTE_COMPONENTS` in `desktop/src/pages/NotePage.tsx` (matching `CHAT_MARKDOWN_COMPONENTS.code` in `CopilotChat.tsx`):
   - Check `const text = typeof props.children === "string" ? props.children.trim() : "";`.
   - If `/language-/.test(props.className ?? "") || text.includes("\n") || !isLocalHref(text)`, return `<code {...props} />`.
   - Otherwise return `<code {...props} role="link" tabIndex={0} title={`Open ${text}`} className="cursor-pointer hover:border-accent hover:text-accent" onClick={() => void openLocalFile(text)} onKeyDown={(e) => { if (e.key === "Enter") void openLocalFile(text); }} />`.

### B. Make Inline `<code>` Local File Paths Clickable & Styled in `NoteEditor.tsx` (`desktop/src/components/NoteEditor.tsx` & `desktop/src/components/noteFormatting.ts`)
1. In `desktop/src/components/NoteEditor.tsx` (`BubbleMenuWrapper` click handler):
   - Check for clicks on inline `<code>` elements (`event.target.closest("code:not(pre code)")`).
   - If `!event.ctrlKey && !event.metaKey && !event.shiftKey` and `isLocalHref(code.textContent?.trim())`, call `event.preventDefault(); void openLocalFile(code.textContent.trim());`.
2. In `desktop/src/components/noteFormatting.ts` (or `NoteEditor.tsx`):
   - Add a lightweight ProseMirror decoration (either in a small `LocalCodeLinks` extension or alongside `mathPreview`) that finds text nodes carrying the `code` mark whose trimmed text satisfies `isLocalHref(text)` and applies `Decoration.inline(from, to, { class: "cursor-pointer hover:border-accent hover:text-accent", title: `Open ${text}`, role: "link" })`.
   - This gives local file paths in inline code the exact same pointer cursor, tooltip, and amber hover border/text in **Draft** mode as in **Published** mode and in **CopilotChat**.

### C. Preserve Backslashes in `NoteLink.renderMarkdown` (`desktop/src/components/NoteEditor.tsx`)
1. In `NoteLink.renderMarkdown` (`desktop/src/components/NoteEditor.tsx`):
   - Escape backslashes that precede ASCII punctuation (`href.replace(/\\(?=[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g, "\\\\")`) when wrapping in `<...>` so UNC paths (`\\SYFILEAPP1\...`) and Windows paths with parenthesized/bracketed segment names round-trip through CommonMark link parsing (`marked` and `react-markdown`) without losing their backslashes.

---

## 3. User-Driven Testing Plan

1. **Test Clicking File References in `C44E AVVENTO` (Published Mode)**:
   - Open the **C44E AVVENTO** note in Space 1 and scroll to **File References**.
   - Hover over `` `\\SYFILEAPP1\Shared\Spirit 44E\44 001 Avvento\44E01 Documentation\Spirit 44E - Owner's Manual.pdf` `` (or any of the `\\SYFILEAPP1\...` file paths).
   - **Expected**: The code pill highlights with the amber accent border/text and `Open \\SYFILEAPP1\...` tooltip (matching the chat), and clicking it opens the PDF.
2. **Test Clicking File References in Draft Mode & After Copy/Paste**:
   - Switch **C44E AVVENTO** to **Draft** mode (or copy a response with file references from the chat and paste into a draft note).
   - Hover over and click one of the `\\SYFILEAPP1\...` file references directly in the draft editor.
   - **Expected**: It highlights on hover and opens the file on click in both Draft and Published modes.
