# Implementation Plan: URL Title on Paste, Bubble Menu Heading Dropdown, and HTML-Only .msg Support

**Task ID:** `feat-url-title-bubble-dropdown-html-msg`  
**Branch:** `feat-url-title-bubble-dropdown-html-msg`  
**Implementer:** Jibby (Claude Code)  
**Lead Architect & Reviewer:** Nero (Google Antigravity / Gemini 3.1 Pro)

---

## 1. Overview & Context

This implementation addresses three distinct user requests:
1. **URL Title Fetching on Paste:** When pasting a URL into markdown editors (notes, task descriptions, comments), fetch page metadata via `/api/url-metadata?url=...` and replace the pill's display label with the page title (matching the behavior of the `/link` dialog).
2. **Compact Heading Dropdown in Bubble Menu:** In the floating selection bubble menu in `NoteEditor.tsx`, collapse the four separate heading/paragraph buttons (`[ T H1 H2 H3 ]`) into a single compact dropdown/select menu showing the active state (e.g. `T ▾`, `H1 ▾`) to save screen space and reduce mouse travel.
3. **HTML-Only Outlook `.msg` Text Extraction:** Fix the error `"(no plain text body; HTML body available with --json)"` when reading Outlook emails that only contain an HTML body without a plain-text fallback, extracting clean readable plain text from `htmlBody`.

---

## 2. Invariants & Safety Rules

- **Dev Server Inactivity:** Background development servers (backend on port 8000, desktop Vite on port 5173) must remain **stopped** during all code editing.
- **Git Branch:** All work must take place on `feat-url-title-bubble-dropdown-html-msg`.
- **Sync Rule:** `docs/AGENT_SETUP.md`, `GEMINI.md`, and `CLAUDE.md` must remain 100% identical.

---

## 3. Detailed Component Plan

### A. Backend: HTML-to-Text Fallback for Outlook `.msg` Files

**Target Files:**
- `backend/read_msg.py`
- `backend/tests/test_read_msg.py`

#### Implementation Steps:
1. In `backend/read_msg.py`:
   - Implement `html_to_plain_text(html_str: str) -> str`:
     - Cleanly parse HTML into plain text.
     - Try using `bs4` (`BeautifulSoup(html_str, "html.parser")`), decomposing non-content tags (`<script>`, `<style>`, `<head>`, `<meta>`), and getting text separated by newlines.
     - Fallback to standard library `re` and `html.unescape` if `bs4` is unavailable:
       - Strip `<script>` and `<style>` blocks.
       - Replace `<br>`, `</p>`, `</div>`, `</tr>`, `</li>`, `</h1>`... with newlines.
       - Strip all remaining tags `<[^>]+>`.
       - Decode HTML entities.
     - Normalize whitespace and collapse excess consecutive newlines to maximum 2 (`\n\n`).
   - In `read_msg(file_path, ...)`:
     - Check if `msg.body` is empty or whitespace-only.
     - If `body` is empty and `html_body` is present: compute `plain_body = html_to_plain_text(html_body)` and use it as `body`.
   - In `format_msg_for_display(data)`:
     - If `body` is empty and `html_body` is present: set `body = html_to_plain_text(data["html_body"])`.
     - Remove the hardcoded string `"(no plain text body; HTML body available with --json)"`.
     - If neither body nor html_body has text, display `"(empty body)"`.
2. In `backend/tests/test_read_msg.py`:
   - Add unit tests verifying:
     - An email with `body=""` and `htmlBody=b"<p>Inspected <b>keel</b> &amp; <i>rudder</i>.</p>"` extracts `body="Inspected keel & rudder."`.
     - `format_msg_for_display` formats this message with the extracted plain text.
     - `local_files.read_local_file` returns the extracted text without error.

---

### B. Frontend: Bubble Menu Heading Dropdown

**Target Files:**
- `desktop/src/components/NoteEditor.tsx`

#### Implementation Steps:
1. In `desktop/src/components/NoteEditor.tsx`:
   - Create a `HeadingDropdown` component:
     - Props: `heading: number` (0 for normal text/paragraph, 1 for H1, 2 for H2, 3 for H3), `disabled?: boolean`, `onSelect: (level: number) => void`.
     - Renders a trigger button with `currentLabel` (`heading === 0 ? "T" : "H" + heading`) and a subtle down chevron `▾`.
     - Keeps `onMouseDown={(e) => e.preventDefault()}` on the trigger and option buttons to preserve ProseMirror's active selection.
     - When opened, shows a popover/listbox with 4 options:
       - `Normal text` (tag: `T`) -> level 0
       - `Heading 1` (tag: `H1`) -> level 1
       - `Heading 2` (tag: `H2`) -> level 2
       - `Heading 3` (tag: `H3`) -> level 3
     - Highlights the active option and closes on selection, click outside, or Escape.
   - In `SelectionMenu`:
     - Replace the four buttons:
       ```tsx
       <ToolButton label="Normal text" on={active.heading === 0} ...>T</ToolButton>
       {HEADING_LEVELS.map((level) => (<ToolButton ...>H{level}</ToolButton>))}
       ```
       with:
       ```tsx
       <HeadingDropdown
         heading={active.heading}
         onSelect={(level) => {
           if (level === 0) chain().setParagraph().run();
           else chain().toggleHeading({ level: level as 1 | 2 | 3 }).run();
         }}
       />
       ```

---

### C. Frontend: URL Title Fetching on Paste

**Target Files:**
- `desktop/src/components/referencePill.tsx`
- `desktop/src/components/NoteEditor.tsx`
- `desktop/src/components/TaskPanel.tsx`
- `desktop/src/components/refPanels.tsx`

#### Implementation Steps:
1. In `desktop/src/components/referencePill.tsx`:
   - Export helper `fetchUrlTitle(url: string, signal?: AbortSignal): Promise<string | null>`:
     - Uses `getJson<{ title: string | null }>(/api/url-metadata?url=${encodeURIComponent(url)}, signal)`.
     - Returns trimmed title if available, or null on error / no title.
     - Maintains a module-level `URL_TITLE_CACHE = new Map<string, string>()` to avoid redundant network calls.
2. In `desktop/src/components/NoteEditor.tsx`:
   - Implement `pillUrlTitlesRef.current()`:
     - Scans `editor.state.doc` for any `referencePill` nodes where `attrs.kind === "url"` and `attrs.href` starts with `http://` or `https://` and `attrs.label === attrs.href` (or empty label).
     - Gathers unique URLs to fetch.
     - Asynchronously fetches titles via `fetchUrlTitle(url)`.
     - When resolved, if editor is not destroyed and title is found:
       - Dispatches a ProseMirror transaction with `tr.setNodeMarkup(pos, undefined, { ...node.attrs, label: title })`.
       - Applies `tr.setMeta("addToHistory", false)` so undo remains clean.
       - Triggers `onChangeRef.current(editor.getMarkdown())`.
   - Wire `pillUrlTitlesRef` into:
     - `handlePaste`: after paste lands (`setTimeout(() => { void pillLocalPathsRef.current(); void pillUrlTitlesRef.current(); })`).
     - `pasteLinkRef`: immediately fetch and apply title if the user pasted at the caret without selecting text.
3. In `desktop/src/components/TaskPanel.tsx`:
   - In `pasteLink(event, setValue)`:
     - When a web URL (`http://` or `https://`) is pasted and the user had no selected text:
       - Insert the initial pill markdown `[href](href "ref:url")`.
       - Asynchronously call `fetchUrlTitle(href)`.
       - When the title resolves: if the textarea still contains `[${href}](${href} "ref:url")`, replace it with `[${title}](${href} "ref:url")` and dispatch the input update.
4. In `desktop/src/components/refPanels.tsx`:
   - In `LinkPanel`, use the shared `fetchUrlTitle` helper for consistency.

---

## 4. Verification & Testing Strategy

### Automated Testing:
1. **Backend Tests:**
   - Run `pytest backend/tests/test_read_msg.py`.
   - Run full suite: `pytest backend/tests`.
2. **Frontend Type Check & Build:**
   - Run `npm run typecheck` in `desktop/`.
   - Run `npm run build` in `desktop/`.
3. **Playwright E2E Tests:**
   - Create `desktop/tests/url-title-and-bubble-dropdown.spec.ts`:
     - Test 1: Selecting text in NoteEditor displays the compact `HeadingDropdown` button (`T ▾`), opening it lists `Normal text`, `Heading 1`, `Heading 2`, `Heading 3`, and selecting `Heading 1` changes the block to H1 and updates the button label to `H1 ▾`.
     - Test 2: Pasting a URL into NoteEditor creates a link pill and asynchronously resolves its display label to the fetched page title.

### User-Driven Manual Verification Gate:
The User must perform the following manual test before merging:
1. Start the application servers via `start.cmd`.
2. **Test HTML .msg Email:**
   - Open Copilot chat in the app.
   - Attach the Outlook message file (`Re: P5001 CE inspection.msg` or any HTML-only `.msg` file) to the chat.
   - Ask Copilot: *"Can you read and summarize this email?"*
   - Verify Copilot reads and summarizes the actual email body instead of stating that it contains only an HTML body.
3. **Test Bubble Menu Heading Dropdown:**
   - Open any note.
   - Select a few words in a paragraph.
   - Notice the floating bubble menu: verify the four buttons `[ T H1 H2 H3 ]` are now replaced by a single compact dropdown button (`T ▾`).
   - Click `T ▾`, select `Heading 2`: verify the text becomes H2 and the dropdown button shows `H2 ▾`.
4. **Test URL Paste Title Resolution:**
   - Copy any website URL (e.g., `https://github.com` or `https://news.ycombinator.com`).
   - Paste the URL into the note editor at an empty cursor position.
   - Notice that a link pill is immediately created with the URL, and within a few seconds, the pill's display text automatically updates to the actual title of the website (e.g. `GitHub: Let's build from here`).
   - Paste a URL into a task comment textarea: verify the display text updates to the title as well.
