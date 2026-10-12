# Implementation Plan: `chat-markdown` — Fix Agent Response Markdown Rendering in CopilotChat

## Branch
Work on the current feature branch (`feat/local-files`). Do **not** merge or commit to `main`.

---

## 1. Root Causes Identified

1. **Missing Math / LaTeX Markdown Plugins (`remark-math` & `rehype-katex`)**:
   - The agent outputs LaTeX math notation for naval architecture parameters (e.g., `$L_{MAX}$ / $L_H$`, `$L_{WL}$`, `$B_{MAX}$ / $B_H$`, `$RM_{1^\circ}$`, `$A_s$`).
   - Although `remark-math`, `rehype-katex`, and `katex` are already installed in `desktop/package.json` and `desktop/node_modules`, neither `CopilotChat.tsx` nor `NotePage.tsx` enables `remarkMath` and `rehypeKatex` (or imports `katex/dist/katex.min.css`).
   - Worse, when a line contains multiple math expressions with subscripts like `($L_{MAX}$ / $L_H$)`, CommonMark without `remark-math` treats the underscores `_` across the two `$...$` blocks as emphasis (`<em>{MAX}$ / $L</em>`), corrupting the surrounding markdown line.

2. **Multi-Turn Text Concatenation Without Paragraph Breaks (`backend/agent.py` & `CopilotChat.tsx`)**:
   - In `backend/agent.py` (`_StreamState` and `_gemini_events`), delta chunks across multiple tool-calling turns are accumulated in `state.parts` and joined via `"".join(state.parts)` with no `\n\n` separator when a `thought` or `tool_use` occurs between text chunks.
   - When Turn 1 ends without `\n\n` (e.g. `"I will check the files."` or `"Let me read the PDF:\n"`) and Turn 2 begins with block-level markdown (`### Heading`, `* List`, `| Table |`, `---`), `"".join(state.parts)` glues Turn 2 onto the end of Turn 1's line, causing headings, lists, horizontal rules, and tables to fail to parse as markdown blocks.
   - Similarly, in `CopilotChat.tsx` (`progressWith`), `const gap = progress.textBroken && text && !/\s$/.test(text) ? "\n\n" : "";` skips adding `\n\n` when `text` ends with a trailing space `" "` or single `"\n"`, breaking block-level markdown after a tool call or thought.

3. **Incomplete & Low-Contrast `.markdown` Styles in `desktop/src/index.css`**:
   - The assistant reply card in `CopilotChat.tsx` has `bg-surface-raised text-xs text-text-secondary`.
   - In `desktop/src/index.css`, `.markdown code` and `.markdown pre` also use `bg-surface-raised`, resulting in **zero contrast** (invisible code spans and code blocks) inside chat replies.
   - `.markdown h1, .markdown h2, .markdown h3` have no font-size differentiation (rendering at `12px`, identical to paragraph text), and `h4, h5, h6` have no styling at all.
   - `.markdown strong, .markdown b` have no `font-semibold text-text-primary` styling, leaving bold text muted gray (`text-text-secondary`).
   - `.markdown hr` (`---`), nested lists (`ul ul`, `ol ul`, `li + li`), and table headers (`.markdown th`) lack proper spacing and contrast inside chat bubbles.

4. **Local File Links & Citations in Chat (`CopilotChat.tsx`)**:
   - `CopilotChat.tsx` renders `<Markdown>` without `urlTransform` or custom `a` / `code` components.
   - `react-markdown`'s default `urlTransform` strips local file paths (`file:///...`, `C:\...`, `Y:\...`, `\\SYFILEAPP1\...`), preventing links to local files/folders from working.
   - Additionally, agents frequently cite local file paths in inline code backticks (e.g. `` `\\SYFILEAPP1\Shared\Spirit 44E\...` ``). Turning inline code spans whose text is a valid local path (`isLocalHref`) or markdown links with `isLocalHref` into clickable local file links (`openLocalFile`) makes agent file citations work seamlessly.

5. **Rich Clipboard Copy (`copyReply` in `CopilotChat.tsx`)**:
   - Currently `copyReply` only writes raw markdown as `text/plain`, so copying an agent response and pasting it into the rich-text `NoteEditor` pastes literal markdown symbols (`\*\*\*`, `\*`, `\_`). Writing both `text/html` (from the rendered `.markdown` DOM element) and `text/plain` (the raw markdown) via `ClipboardItem` allows pasting formatted content cleanly into notes.

---

## 2. Technical Implementation Steps

### A. `backend/agent.py` & `backend/tests/test_agent.py`
1. In `_StreamState` (`backend/agent.py`):
   - Add `self.text_broken: bool = False`.
   - In `_gemini_events`:
     - When `kind == "thought"` or `kind == "tool_use"`, if `state.parts` is non-empty, set `state.text_broken = True`.
     - When `kind == "message"` and `event.get("role") == "assistant"` with non-empty `content`:
       - If `state.text_broken` is `True` and `state.parts` is non-empty:
         - Check the trailing text in `"".join(state.parts)`. If it does not end with `\n\n` (and `content` does not start with `\n\n`), prepend `\n\n` (or `\n` if it already ends with `\n`) to the stored part so there is always a blank line separating pre-tool text from post-tool markdown blocks.
         - Reset `state.text_broken = False`.
2. Add a unit test in `backend/tests/test_agent.py` verifying that `_parse_gemini_stream` / `_gemini_events` inserts `\n\n` between assistant text chunks separated by a `thought` or `tool_use` event so block-level markdown (`### Heading`, `* List`) starts on a new paragraph.

### B. `desktop/src/components/CopilotChat.tsx`
1. Import `remarkMath` from `"remark-math"`, `rehypeKatex` from `"rehype-katex"`, and `"katex/dist/katex.min.css"`.
2. Import `defaultUrlTransform, type Components` from `"react-markdown"` and `isLocalHref, openLocalFile` from `"../lib/localFiles"`.
3. In `progressWith` (`case "text_delta"`):
   - When `progress.textBroken && text` is true:
     - Ensure at least `\n\n` separates `text.trimEnd()` and `event.delta` (unless `event.delta` already begins with `\n\n`), so trailing spaces or a single `\n` do not prevent a paragraph break before headings, lists, or tables.
4. Create a `<ChatMarkdown content={...} />` component used in:
   - Completed assistant replies (`entry.content`)
   - Live streaming preview (`preview` in `LiveActivityCard`)
   - Live streaming thought text (`thoughtText` in `LiveActivityCard`)
5. Configure `<ChatMarkdown>` with:
   - `remarkPlugins={[remarkGfm, remarkMath]}`
   - `rehypePlugins={[rehypeKatex]}`
   - `urlTransform={chatUrlTransform}` (allowing `file:`, drive letters, and UNC paths via `isLocalHref` just like `NotePage.tsx`)
   - `components={CHAT_MARKDOWN_COMPONENTS}`:
     - `a`: if `props.href && isLocalHref(props.href)`, render a clickable link that calls `openLocalFile(props.href)` on click; otherwise render `<a {...props} target="_blank" rel="noopener noreferrer" />`.
     - `code`: if it is an inline code span (no `className` with `language-`) and its text content matches `isLocalHref(text.trim())` (e.g. `` `\\SYFILEAPP1\Shared\...` `` or `` `Y:\...` ``), render a clickable element styled as code/pill that calls `openLocalFile(text.trim())` on click.
6. Update `copyReply(index: number, text: string, containerEl?: HTMLElement | null)`:
   - If `containerEl` (the `.markdown` div for that reply) and `typeof ClipboardItem !== "undefined"` and `navigator.clipboard?.write` are available, write both `text/html` (`new Blob([containerEl.innerHTML], { type: "text/html" })`) and `text/plain` (`new Blob([text], { type: "text/plain" })`) so pasting into `NoteEditor` pastes rich formatted HTML rather than escaped markdown characters; fall back to `navigator.clipboard.writeText(text)`.

### C. `desktop/src/pages/NotePage.tsx`
1. Import `remarkMath` from `"remark-math"`, `rehypeKatex` from `"rehype-katex"`, and `"katex/dist/katex.min.css"`.
2. In `NotePage.tsx`'s `<Markdown>`, add `remarkMath` to `remarkPlugins={[remarkGfm, remarkMath]}` and `rehypeKatex` to the end of `rehypePlugins` (`[rehypeRaw, [rehypeSanitize, NOTE_HTML_SCHEMA], liftCellColors, layoutMedia, rehypeKatex]`) so math formulas render in published notes as well.

### D. `desktop/src/index.css`
1. Update `.markdown` styles (lines 48–85) to provide clear typography and contrast inside chat replies while keeping `.note-body` overrides intact:
   - `.markdown h1`: `@apply mt-3 text-base font-semibold text-text-primary;`
   - `.markdown h2`: `@apply mt-3 text-sm font-semibold text-text-primary;`
   - `.markdown h3`: `@apply mt-2.5 text-[13px] font-semibold text-text-primary;`
   - `.markdown h4, .markdown h5, .markdown h6`: `@apply mt-2 text-xs font-semibold text-text-primary;`
   - `.markdown strong, .markdown b`: `@apply font-semibold text-text-primary;`
   - `.markdown hr`: `@apply my-3 border-border-default;`
   - `.markdown ul`: `@apply list-disc pl-5 space-y-1;`
   - `.markdown ol`: `@apply list-decimal pl-5 space-y-1;`
   - `.markdown li > ul, .markdown li > ol`: `@apply mt-1;`
   - `.markdown code`: `@apply rounded border border-border-default bg-background/70 px-1 py-0.5 font-mono text-[11px] text-text-primary;`
   - `.markdown pre`: `@apply overflow-x-auto rounded-md border border-border-default bg-background/80 p-2.5 font-mono text-[11px] text-text-primary;`
   - `.markdown pre code`: `@apply border-0 bg-transparent p-0;`
   - `.markdown th`: `@apply border border-border-default bg-background/60 px-2 py-1 text-left font-semibold text-text-primary;`

### E. Clean Up Escaped Markdown in `backend/data/spaces/1/content/C44E AVVENTO.md`
1. Unescape `\*\*\*`, `\*\*`, `\*`, `\_`, `\~`, `&amp;`, and `\\circ` in `backend/data/spaces/1/content/C44E AVVENTO.md` so the saved Avvento note renders cleanly.

---

## 3. Automated QA & Verification Steps
1. Run `npm run build` in `desktop/` to verify TypeScript typechecking (`tsc -b`) and Vite production bundling succeed without errors.
2. Run `pytest` in `backend/` to verify all backend unit tests (including the new multi-turn markdown spacing test) pass.

---

## 4. User-Driven Testing Plan (Manual Verification Gate)
1. **Verify Chat Markdown & Math Rendering**:
   - Open the Co-Pilot app in the browser and open the right-hand **Ask the knowledge base** chat panel.
   - Run `/design-search find me the main design parameters for the yacht AVVENTO`.
   - Verify that:
     - Section headings (`### 1. Principal Dimensions & Hydrostatics`, etc.) render visibly larger and brighter (`text-text-primary`) than body text, separated by clean horizontal rules (`---`).
     - Bold labels (`**Length Overall...**`) are bright and bold (`text-text-primary`), and nested bullet lists have clean spacing.
     - Math / LaTeX expressions (`$L_{MAX}$ / $L_H$`, `$L_{WL}$`, `$RM_{1^\circ}$`, `$A_s$`) render as formatted mathematical notation via KaTeX rather than raw `$L_{MAX}$` strings or broken italics.
     - Inline code spans (e.g., `` `GB-SPY/44E01/H/0/20` ``) have a distinct background and border box, and cited local file paths (`` `\\SYFILEAPP1\Shared\...` ``) are clickable to open/download the local file.
2. **Verify Copy & Paste into a Note & Published Note Rendering**:
   - Click **Copy** on the agent's reply in the chat and paste it into a draft note in the Note Editor, or open the existing **C44E AVVENTO** note.
   - Verify that headings, bold text, bullet lists, and math expressions render cleanly without literal `\*` or `\_` escapes.
