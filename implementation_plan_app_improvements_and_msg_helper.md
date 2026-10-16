# Implementation Plan: App Loading Screen, Bubble Formatting Toolbar, Outlook .msg Helper, and Auto URL Link Pills

**Task ID:** `feat-app-improvements-and-msg-helper`  
**Branch:** `feat/app-improvements-and-msg-helper`

---

## 1. Objectives

1. **Application Loading Screen**:
   - Provide an instant, beautifully branded loading/splash screen inside `desktop/index.html` (inside `#root`) so users never see a blank white flash while JS bundles, fonts, and assets download and initialize.
   - Display the Daily Copilot brand emblem/logo, title ("Daily Copilot" in Cinzel font), and an animated pulsing loader styled with CSS variables from `brand.css` (with automatic light and dark mode support).
   - In `desktop/src/components/Layout.tsx` and `desktop/src/lib/space.tsx`, ensure initial space/data hydration transitions smoothly.

2. **Compact Formatting Toolbar in Floating Bubble Menu**:
   - In `desktop/src/components/NoteEditor.tsx`, expand `SelectionMenu` (the floating bubble menu that appears when text is highlighted in notes or task descriptions) to include a compact, low-mouse-travel formatting bar:
     - Heading selector / buttons (Normal text, H1, H2, H3).
     - Inline text styles (Bold, Italic, Strikethrough).
     - Text Color picker (compact palette with current active color dot).
     - Lists (Bullet list, Ordered list, Task checklist).
     - Actions: Existing "Create task" (`+ Task`) and "Link" (`🔗 Link`) buttons.
   - Ensure all buttons prevent default on mouse down (`e.preventDefault()`) so clicking buttons never drops the user's text selection.

3. **Outlook Email Files (.msg) Helper & Agent Reading**:
   - Provide `scripts/read_msg.py` (and `backend/read_msg.py`) allowing the agent or user to read `.msg` email files from CLI:
     `python scripts/read_msg.py <file.msg> [--json] [--extract-attachments [out_dir]]`
   - In `backend/local_files.py`: Update `read_local_file(path)` so that `.msg` files are parsed via `read_msg`, extracting Subject, From, To, CC, Date, Attachments, and clean message body.
   - In `backend/agent.py`:
     - Update `SYSTEM_PROMPT` and CLI guides to inform the agent that Outlook `.msg` files can be read via `read_local_file` or `python scripts/read_msg.py <path>`.
     - In `_extract_attachment_text(path)`, extract and embed `.msg` email text when attached directly in chat.
   - Add unit tests in `backend/tests/test_read_msg.py`.

4. **Automatic URL Detection & Conversion to Link Pills Across All Editors**:
   - In `desktop/src/components/NoteEditor.tsx`:
     - In `handlePaste`: Detect if the pasted clipboard data is a URL (`http://...`, `https://...`, `file:///...`, `\\server\...`, `/note?...`, `/tasks/...`).
     - If text was selected: Replace the selection with a link pill using the selected text as `label` and the pasted URL as `href`.
     - If no text was selected: Insert a link pill with the URL as both `label` and `href`, followed by a trailing space.
     - Detect bare URLs in pasted content and convert them to reference pills.
   - In `desktop/src/components/TaskPanel.tsx`:
     - Task Description uses `NoteEditor` (compact), inheriting the paste behavior.
     - In task comments (`Comments` and `CommentItem`):
       - On paste into comment textarea, convert pasted URLs into `[label](url "ref:url")` markdown links.
       - Render comments with link pill support so URLs and pills display as interactive pills.

---

## 2. Proposed Architecture & File Changes

### Backend Changes

1. **`backend/read_msg.py` & `scripts/read_msg.py`**:
   - Ensure `read_msg(file_path, extract_attachments_dir)` safely parses `.msg` files with `extract_msg`.
   - Provide summary formatter (`format_summary(data)`) for terminal and agent consumption.
   - Support CLI arguments: `--json`, `--extract-attachments`, `--quiet`.

2. **`backend/local_files.py`**:
   - In `read_local_file(path)`:
     ```python
     if suffix == ".msg":
         from read_msg import MsgReadError, format_summary, read_msg
         try:
             data = read_msg(file)
             content = _truncate(format_summary(data))
             return {**meta, "subject": data.get("subject"), "from": data.get("from"), "attachments": len(data.get("attachments", [])), "content": content}
         except MsgReadError as exc:
             raise LocalFileError(f"Could not read the Outlook message {file}: {exc}") from exc
     ```

3. **`backend/agent.py`**:
   - In `_extract_attachment_text(path)`:
     Add `.msg` handling using `read_msg` to extract email subject, sender, date, and body for the model prompt.
   - Update prompt guidelines (`SYSTEM_PROMPT`, `_CLI_TOOLS_GUIDE`, `_GEMINI_TOOLS_GUIDE`) mentioning `.msg` files.

4. **`backend/tests/test_read_msg.py`**:
   - Test CLI invocations (`--json`, summary, missing file, corrupt file).
   - Test `read_local_file` with `.msg` files.

---

### Desktop Frontend Changes

1. **`desktop/index.html`**:
   - Add inline loading splash inside `<div id="root">`:
     - Uses CSS variables from `/styles/brand.css`.
     - Includes centered Daily Copilot emblem SVG.
     - Title: `<h1 class="dc-splash-title">DAILY COPILOT</h1>`.
     - Pulsing loading bar / spinner.
     - Smooth fade-in and graceful replacement when React mounts.

2. **`desktop/src/components/NoteEditor.tsx`**:
   - In `SelectionMenu`:
     - Add formatting controls:
       - Heading select / buttons (Normal, H1, H2, H3).
       - Bold, Italic, Strikethrough toggle buttons with active state styling.
       - Compact ColorPicker button with palette.
       - Bullet list, Ordered list, Task list (checkbox).
       - Divider.
       - Existing "Create task" and "Link" buttons.
     - Maintain selection on button clicks with `onMouseDown={(e) => e.preventDefault()}`.
   - In `handlePaste`:
     - Inspect `event.clipboardData.getData("text/plain")`.
     - If string is a valid URL:
       - If selection is non-empty: replace selection with a `referencePill` (kind `url`, href `url`, label `selectedText`).
       - If selection is empty: insert `referencePill` (kind `url`, href `url`, label `url`) + space.
       - Prevent default paste.

3. **`desktop/src/components/TaskPanel.tsx`**:
   - In `Comments`:
     - Add URL paste detection in comment textarea: if URL is pasted, insert markdown pill `[selectedText || url](url "ref:url")`.
     - In `CommentItem`: render comment text with interactive reference pills or Markdown component.

---

## 3. Verification & Testing

### Automated Tests
1. `pytest backend/tests/test_read_msg.py` & full test suite `pytest backend/tests`.
2. Frontend typecheck: `npm run typecheck` in `desktop/`.
3. Frontend build: `npm run build` in `desktop/`.
4. Playwright tests:
   - Create `desktop/tests/bubble-formatting-toolbar.spec.ts`: test that selecting text opens the bubble menu with heading, bold, color, and list buttons, and clicking them formats the text without losing focus.
   - Create `desktop/tests/url-paste-pills.spec.ts`: test pasting URLs into note editor and comment inputs, verifying they convert to interactive link pills.
   - Verify existing specs: `chat-attachments.spec.ts`, `pdf-continuous-scroll.spec.ts`, `chat-history-sync.spec.ts`.

### Manual, User-Driven Testing Gate (Mandatory)
1. **Application Loading Screen**:
   - Hard-refresh the browser (`Ctrl+F5`) at `http://localhost:5173/`.
   - Verify the branded splash screen (logo, title in Cinzel, pulsing loader) appears immediately while the app loads.
2. **Compact Formatting Toolbar**:
   - Open any note in the note editor.
   - Highlight some text: observe the floating bubble menu appearing directly above/below the text.
   - Verify the compact formatting tools: click H2, Bold, Italic, Bullet list, or pick a color.
   - Verify the text updates formatting immediately without needing to move the mouse to the top of the window.
3. **Outlook Email (.msg) Helper**:
   - Run `python scripts/read_msg.py <sample.msg>` in terminal to verify readable summary.
   - In chat or with Co-pilot, ask questions about a `.msg` file or attach a `.msg` file in chat.
4. **Pasted URL Pills**:
   - In a note or task description, paste a URL (`https://example.com` or `https://github.com`): verify it automatically converts into a link pill.
   - Highlight a word (e.g. "Google") and paste `https://google.com`: verify the word becomes a link pill pointing to that URL.
   - In task comments, paste a URL and verify it formats as a link pill.
