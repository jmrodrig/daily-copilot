# Implementation Plan: Phase 14 - Embedded Excel Spreadsheets & Assistant Spreadsheet Skill

## Task ID: phase-14-spreadsheets
## Branch: phase-14-spreadsheets

---

## 1. Problem Statement & Motivation
Users need to embed and work with spreadsheets inside their project notes, alongside whiteboards, voice recordings, and text:
1. **Embedded Spreadsheet Frames**:
   - Similar to the whiteboard (`WhiteboardWidget`), notes should support embedding spreadsheets as first-class blocks (````spreadsheet ... ````).
   - **Collapsed State (In Note)**: Minimal functionality—a compact, clean grid preview (~300px height) showing sheet tabs, row/column headers, cell values, and an "Expand / Fullscreen" button.
   - **Expanded State (Click to Expand)**: Full functionality with a dedicated toolbar—formula bar (`fx`), cell formatting (bold, italic, alignment), row/column operations, sheet management (add/switch/rename sheets), import `.xlsx`, export `.xlsx`/`.csv`, and Esc/collapse button to return to the note.
2. **Assistant Spreadsheet Reading Skill**:
   - The Daily Copilot assistant and Antigravity agents need to read, search, and analyze `.xlsx`, `.xlsm`, `.csv`, and `.tsv` files:
     - Accessing sheet structures, cell values, and formulas (e.g. `=B2*C2`, `=SUM(...)`).
     - Searching cells by keywords or line items without loading unneeded megabytes into context.
     - Integrating into `backend/local_files.py` (`read_local_file`) and `backend/agent.py` (`read_spreadsheet`).
     - Creating an Antigravity agentic skill in `C:\Users\designer\.gemini\config\skills\spreadsheet_reader\SKILL.md`.

---

## 2. Architecture & Component Changes

### A. Spreadsheet Data Model & Core (`desktop/src/components/spreadsheet.ts`)
1. Types:
   - `SpreadsheetStyle`: `{ bold?: boolean; italic?: boolean; align?: "left" | "center" | "right"; bg?: string; color?: string }`
   - `SpreadsheetSheet`: `{ name: string; rows: string[][]; styles?: Record<string, SpreadsheetStyle> }`
   - `SpreadsheetData`: `{ activeSheet: string; sheets: SpreadsheetSheet[]; title?: string }`
2. Formula & Evaluation Engine:
   - Basic spreadsheet formula evaluator supporting `=SUM(...)`, `=AVERAGE(...)`, `=COUNT(...)`, `=MIN(...)`, `=MAX(...)`, and basic arithmetic (`+`, `-`, `*`, `/`, parenthesis) on cell coordinates (e.g. `A1`, `B2`).
   - Cell coordinate helpers: `colLetter(index: number)`, `parseCellAddress(addr: string)`.
3. Import & Export (via `xlsx` package):
   - `parseWorkbookBuffer(buffer: ArrayBuffer): SpreadsheetData`: Reads workbook, sheets, and formulas into `SpreadsheetData`.
   - `exportWorkbook(data: SpreadsheetData, filename?: string, format?: "xlsx" | "csv")`: Exports data to file.
   - `EMPTY_SPREADSHEET_JSON`: Default empty 5×5 spreadsheet template.

### B. ProseMirror / TipTap Node (`desktop/src/components/noteFormatting.ts` & `desktop/src/components/SpreadsheetWidget.tsx`)
1. In `desktop/src/components/noteFormatting.ts`:
   - `EMPTY_SPREADSHEET_JSON`: Stringified default spreadsheet data.
   - `SpreadsheetBlock`: TipTap block node for `"spreadsheet"`, parsing and rendering ````spreadsheet\n{...}\n```` code blocks with newline/backtick escaping.
2. In `desktop/src/components/SpreadsheetWidget.tsx`:
   - `SpreadsheetNode`: Extends `SpreadsheetBlock` with `ReactNodeViewRenderer(SpreadsheetNodeView, { stopEvent: () => true })`.
   - `SpreadsheetFrame`:
     - Holds `fullscreen` state (`useState(false)`).
     - When collapsed: Renders compact inline frame (~300px), header bar with sheet selector, compact grid preview, and expand button (`EXPAND_ICON`).
     - When fullscreen: Renders via `createPortal` to `document.body` as a full-window modal with the complete `SpreadsheetView`.
     - In-note placeholder when fullscreen: Displays message `"The spreadsheet is open in full view. [Back to the note]"`.
3. In `desktop/src/components/SpreadsheetView.tsx`:
   - Full spreadsheet view featuring:
     - **Top Toolbar**:
       - Title / file name
       - Import `.xlsx` button (loads any `.xlsx` or `.csv` from disk)
       - Export `.xlsx` / `.csv` button
       - Cell formatting: Bold, Italic, Text Alignment (Left, Center, Right)
       - Row / Column operations: Add Row, Delete Row, Add Column, Delete Column
       - Fullscreen exit / Collapse button (`COLLAPSE_ICON` / Esc)
       - Trash / Delete block button (if editable and requested)
     - **Formula Bar**:
       - Selected cell indicator (e.g. `A1`)
       - Formula input (`fx`) allowing typing values or `=SUM(A1:A5)`
     - **Interactive Grid**:
       - Column headers (`A`, `B`, `C`, ...)
       - Row headers (`1`, `2`, `3`, ...)
       - Cell navigation (arrow keys, Enter, Tab), double click to edit
       - Formula display vs calculated value display
     - **Bottom Sheet Tabs**:
       - Tabs for each sheet with active highlight
       - `+` button to add new sheet
       - Rename / delete sheet options

### C. Note Editor Integration (`desktop/src/components/NoteEditor.tsx`)
1. Register `SpreadsheetNode` in `useEditor` extensions.
2. Add `/spreadsheet` to `slashCommand.tsx` menu items.
3. Add `<ToolButton label="Insert spreadsheet" ...><SpreadsheetIcon /></ToolButton>` to NoteEditor toolbar.
4. Support drag-and-drop / file pasting of `.xlsx`, `.xlsm`, `.csv` into the editor, converting them into embedded spreadsheet blocks.

### D. Backend Tool & Integration (`backend/read_spreadsheet.py`, `backend/local_files.py`, `backend/agent.py`)
1. `backend/read_spreadsheet.py`:
   - Ensure CLI and module support reading `.xlsx`, `.xlsm`, `.csv`, `.tsv` with sheet selection, searching, and formula inspection.
   - Copy to `scripts/read_spreadsheet.py` for CLI access.
2. `backend/local_files.py`:
   - Update `read_local_file` to support spreadsheet extensions: formats sheets as readable markdown tables with formulas.
3. `backend/agent.py`:
   - Add `"read_spreadsheet"` tool in `TOOLS` with `path`, `sheet`, and `search` parameters.
   - Implement tool execution calling `read_spreadsheet.py`.
4. Tests:
   - Create `backend/tests/test_read_spreadsheet.py` testing workbook parsing, sheet selection, formula reading, cell search, and error handling.

### E. Antigravity Agent Skill
- Create `C:\Users\designer\.gemini\config\skills\spreadsheet_reader\SKILL.md` (and `.gemini/config/skills/spreadsheet_reader/SKILL.md`).
- Document capabilities for inspecting, reading, and computing with spreadsheets across projects.

---

## 3. Implementation Steps for Jibby (Claude Code)
1. **Backend & Tests**:
   - Integrate `read_spreadsheet` into `backend/local_files.py` and `backend/agent.py`.
   - Copy `backend/read_spreadsheet.py` to `scripts/read_spreadsheet.py`.
   - Write tests in `backend/tests/test_read_spreadsheet.py` and verify with `pytest`.
2. **Frontend Spreadsheet Engine & Components**:
   - Create `desktop/src/components/spreadsheet.ts` (data model, formula evaluator, xlsx import/export).
   - Add `SpreadsheetBlock` to `desktop/src/components/noteFormatting.ts`.
   - Create `desktop/src/components/SpreadsheetView.tsx` and `desktop/src/components/SpreadsheetWidget.tsx`.
   - Register in `desktop/src/components/NoteEditor.tsx` (extensions, toolbar, slash commands).
3. **Skill Creation**:
   - Create `C:\Users\designer\.gemini\config\skills\spreadsheet_reader\SKILL.md` and `.gemini/config/skills/spreadsheet_reader/SKILL.md`.
4. **Verification**:
   - Run `npm --prefix desktop run build` to verify TypeScript and Vite compilation.
   - Run `pytest backend/tests/test_read_spreadsheet.py` and `pytest backend/tests/`.
   - Commit all changes to branch `phase-14-spreadsheets`.

---

## 4. User-Driven Manual Testing Plan
1. **Insert & Collapsed Frame Test**:
   - Open a note in Daily Copilot.
   - Type `/spreadsheet` or click the Spreadsheet button in the note toolbar.
   - **Verify**: A spreadsheet widget is inserted.
   - **Verify**: In its collapsed state, it renders a clean, compact grid preview with sheet tabs, row/column labels, and an expand button.
2. **Expand / Fullscreen Test**:
   - Click the "Expand" button on the spreadsheet frame.
   - **Verify**: The spreadsheet opens in full view with a dedicated top toolbar, formula bar (`fx`), and full grid.
   - **Verify**: In the background note, the frame shows "The spreadsheet is open in full view. [Back to the note]".
3. **Formulas & Editing Test**:
   - In cell `A1` enter `10`, in `A2` enter `20`.
   - In `A3` enter `=SUM(A1:A2)` or `=A1+A2`.
   - **Verify**: Cell `A3` calculates and displays `30`.
   - Test formatting (Bold, Italic, Alignment) on selected cells.
   - Add a second sheet (`Sheet2`) via the `+` button at the bottom.
4. **Export & Import Test**:
   - Click "Export" to export the spreadsheet as `.xlsx`.
   - Save or close, and use "Import" to load an `.xlsx` file from disk.
   - **Verify**: Sheets and data are populated accurately.
   - Press Esc or click "Exit fullscreen" to return to the note.
   - **Verify**: The note saves the spreadsheet block with all data intact.
5. **Assistant Spreadsheet Reading Test**:
   - In the Co-pilot chat, ask: `"What are the values in [path to spreadsheet or note]?"`.
   - **Verify**: The assistant successfully uses the spreadsheet skill/tool to read the sheets and answer with the exact cell values and formulas.
