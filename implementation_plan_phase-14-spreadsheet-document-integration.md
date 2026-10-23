# Implementation Plan: Phase 14 - Spreadsheet Document Integration & Editable Windows

**Task Identifier:** `phase-14-spreadsheet-document-integration`  
**Git Branch:** `phase-14-spreadsheet-document-integration`  
**Related Files:**
- `backend/main.py`
- `backend/agent.py`
- `backend/file_layer.py`
- `desktop/src/components/spreadsheet.ts`
- `desktop/src/components/SpreadsheetView.tsx`
- `desktop/src/components/SpreadsheetWidget.tsx`
- `desktop/src/components/NoteEditor.tsx`
- `desktop/src/pages/NotePage.tsx`
- `desktop/src/components/noteFormatting.ts`
- `.gemini/config/skills/spreadsheet_reader/SKILL.md`
- `backend/tests/test_agent.py`
- `backend/tests/test_read_spreadsheet.py`

---

## 1. Objectives & User Requirements

The user requested an architectural evolution of spreadsheet handling:

1. **(A) Spreadsheets as Attached Resources & Full View Access:**
   - Allow importing Excel (`.xlsx`, `.xlsm`, `.csv`, `.tsv`) and other spreadsheets to notes as attached files (in space assets), or creating a new one.
   - When accessing a spreadsheet (by clicking on its respective link in the note), it opens in **Full View**.
   - Full view requires **full multi-sheet / tabs support** (restored tabs at bottom, add sheet, rename sheet, delete sheet, switch sheets), along with wide-canvas edge overflow, formula autocomplete, and interactive cell picking.
   - In full view, offer a toolbar option to **"Open in native spreadsheet app"** (launches Microsoft Excel or the OS default spreadsheet program on the host machine).
2. **(B) Spreadsheet Widgets as Editable Windows in the Note Body:**
   - To show portions of a spreadsheet in the note body, add/use the spreadsheet widget:
     - Inside the widget, select any spreadsheet attached to or referenced in the document (or space).
     - Upon selection (or clicking "Select Area"), the spreadsheet opens in full view to select the area the user wants to show in the note.
     - The widget becomes an **editable "window"** that allows focusing and editing information from the spreadsheet online directly with the note's text.
     - Changes made in the widget or in full view update the underlying spreadsheet and stay synchronized.
3. **(C) Assistant Integration:**
   - Ensure the AI assistant recognizes this architecture.
   - Give the assistant the capability to **edit spreadsheets** (`edit_spreadsheet` tool in `agent.py`) as well as read them (`read_spreadsheet`), handling both local files and space assets.
   - Update the assistant skill and prompt context so the assistant can edit workbooks, create workbooks, and insert/update spreadsheet window widgets in notes.

---

## 2. Technical Architecture & Component Design

### A. Backend Endpoints & Tools (`backend/main.py`, `backend/agent.py`)

1. **Asset Open in Native App Endpoint:**
   `POST /api/notes/image/{name}/open`
   - Finds the asset on disk via `file_layer.asset_path(name, notes_dir=root)`.
   - Calls `local_files.open_path(str(path))`. On Windows, this runs `os.startfile(path)` which immediately opens Microsoft Excel with the file!
   - Returns `{"status": "ok", "path": str(path)}`.
2. **Asset Update Endpoint:**
   `PUT /api/notes/image/{name}`
   - Accepts binary data / file upload.
   - Overwrites the asset file on disk via `file_layer.asset_path(name, notes_dir=root).write_bytes(data)`.
   - Returns `{"status": "ok", "name": name, "size": len(data)}`.
3. **New Blank Spreadsheet Endpoint:**
   `POST /api/notes/spreadsheet/new`
   - Accepts `space_id: int`, optional `title: str` (e.g. "Spreadsheet.xlsx").
   - Creates a valid minimal `.xlsx` using `openpyxl` with an empty "Sheet1".
   - Saves it under `space.assets` with `file_layer.save_asset(..., filename="Spreadsheet.xlsx")`.
   - Returns `{"url": f"/api/notes/image/{name}?space_id={space_id}", "name": name, "title": "Spreadsheet.xlsx"}`.
4. **Assistant `edit_spreadsheet` Tool in `agent.py`:**
   - Parameters:
     - `path`: local file path or asset URL (`/api/notes/image/...`).
     - `sheet`: optional sheet name (defaults to active/first sheet).
     - `cell`: optional single cell coordinate (e.g. `"B2"`).
     - `value`: optional value or formula to set (e.g. `100` or `"=SUM(B1:B9)"`).
     - `updates`: optional dict of coordinate-value pairs, e.g. `{"B2": 150, "B3": 200, "B4": "=SUM(B2:B3)"}`.
     - `add_sheet`: optional name of a sheet to add.
     - `clear_range`: optional range to clear (e.g. `"A1:C10"`).
   - Loads workbook with `openpyxl.load_workbook(path)`.
   - Resolves paths whether local (`local_files.to_path`) or space asset (`file_layer.asset_path`).
   - Applies modifications and saves with `wb.save(path)`.
   - Update `read_spreadsheet` to resolve asset URLs as well as local file paths.

---

### B. Frontend Data & Workbook Management (`spreadsheet.ts`, `SpreadsheetView.tsx`)

1. **Workbook Buffer Serialization (`spreadsheet.ts`):**
   - Add `writeWorkbookBuffer(data: SpreadsheetData, format?: "xlsx" | "csv"): Promise<Uint8Array>`:
     Uses `XLSX.write(book, { type: "array", bookType: format })` to generate raw file bytes from in-memory `SpreadsheetData`.
   - Export helper `isSpreadsheetFile(filenameOrUrl: string): boolean` matching `.xlsx`, `.xlsm`, `.xls`, `.ods`, `.csv`, `.tsv`.
2. **Restore Multi-Sheet Tabs & Native Open in `SpreadsheetView.tsx`:**
   - Restore the sheet tabs bar at the bottom:
     - Switch tabs: click tab switches active sheet.
     - Add sheet (`+`): creates a new sheet and activates it.
     - Double-click tab to rename sheet inline.
     - Delete sheet (`×`): removes sheet if count > 1.
   - Keep the wide-canvas extended columns (at least 26 cols, running past viewport edge).
   - Keep formula autocomplete and interactive cell picking with marching ants.
   - Add **"Open in native app"** button to the toolbar:
     - If viewing an asset (`/api/notes/image/...`), call `POST /api/notes/image/{name}/open`.
     - If viewing a local file (`file:///...`), call `openLocalFile(href)`.
   - Support optional `onSaveBuffer?: (buffer: Uint8Array) => Promise<void>` or `onChange?: (json: string) => void`.

---

### C. Note Links & Full View Modal (`NoteEditor.tsx`, `NotePage.tsx`)

1. **Spreadsheet Link Interception:**
   - In `NoteEditor.tsx` (bubble menu and click handler) and `NotePage.tsx` (rendered link component):
     - When a link's href or text ends with a spreadsheet suffix (`.xlsx`, `.xlsm`, `.csv`, etc.):
     - Clicking the link intercepts navigation and opens the **`SpreadsheetModal`** in Full View.
2. **Full View Modal (`SpreadsheetModal`):**
   - Fetches the workbook buffer from `href` via `fetch()`.
   - Parses into `SpreadsheetData` via `parseWorkbookBuffer`.
   - Renders `SpreadsheetView` in fullscreen modal dialog with toolbar, formula bar, wide grid, bottom sheet tabs, and "Open in native app".
   - Debounced auto-save: when edits occur, calls `writeWorkbookBuffer` and `PUT /api/notes/image/{name}` to persist back to disk.

---

### D. The Spreadsheet Widget: Editable Window into a Spreadsheet (`SpreadsheetWidget.tsx`)

1. **Widget Data Structure:**
   ```json
   {
     "src": "/api/notes/image/uuid.xlsx?space_id=1",
     "sheet": "Costs",
     "displayArea": "A1:E8",
     "title": "Budget"
   }
   ```
   *(For backward compatibility: if `data.sheets` exists without `src`, it continues to work as legacy embedded JSON).*
2. **Unconnected State (Spreadsheet Picker):**
   - If `!data.src`:
     - Scan current note text/DOM for links to spreadsheets.
     - Render a clean picker card inside the widget:
       - List of attached spreadsheets in the note (e.g. `Budget.xlsx`).
       - Button: "Upload spreadsheet" (opens file picker, uploads as asset, attaches to widget).
       - Button: "Create new spreadsheet" (calls `/api/notes/spreadsheet/new`, attaches to widget).
     - Once selected: opens full view modal in **"Select Area" mode**:
       - The user selects the desired range (e.g. `B2:F10`).
       - Toolbar shows prominent button: **"Set Note Display Area"** (or Done).
       - Clicking it saves `src`, `sheet`, and `displayArea` to the widget node.
3. **Connected "Window" State:**
   - Loads workbook from `src`.
   - Renders strictly the cells in `displayArea` of `sheet`!
   - **Editable Online with Note Text:**
     - Cells can be focused and edited directly in the note widget.
     - Arrow keys and Tab/Enter navigate within the window boundaries.
     - Live formula evaluation.
     - Changes made in the window update the shared workbook and debounced-save back to the file on disk (`PUT /api/notes/image/{name}`).
   - **Widget Controls Overlay (on hover/select):**
     - "Open full view" (expand icon): opens full multi-sheet editor.
     - "Select area" (crop/grid icon): opens full view to adjust the display range.
     - "Open in native app" (Excel icon/button): launches Excel on host.
     - "Remove" (trash icon).
   - **Published Mode (`editable === false`):**
     - Hides row numbers and column letters; displays only the clean window of cells.

---

### E. Assistant Knowledge & Skills

1. Register `edit_spreadsheet` in `backend/agent.py` `TOOLS`.
2. Update `.gemini/config/skills/spreadsheet_reader/SKILL.md` to document:
   - Reading spreadsheets (`read_spreadsheet`).
   - Editing spreadsheets (`edit_spreadsheet`).
   - Document architecture: spreadsheets are stored as attached files, and note widgets act as windows into specific ranges (`displayArea`).
3. Add unit tests for `edit_spreadsheet` in `backend/tests/test_agent.py`.

---

## 3. Implementation Steps for Jibby

1. **Step 1: Backend Asset Endpoints & Assistant Tools**
   - Add `PUT /api/notes/image/{name}`, `POST /api/notes/image/{name}/open`, and `POST /api/notes/spreadsheet/new` in `backend/main.py`.
   - Add `edit_spreadsheet` tool and enhance `read_spreadsheet` to support asset paths in `backend/agent.py`.
   - Add tests in `backend/tests/test_agent.py`.
2. **Step 2: Frontend Data Helpers & Full View Multi-Sheet Support**
   - In `desktop/src/components/spreadsheet.ts`: add `writeWorkbookBuffer`, `isSpreadsheetFile`.
   - In `desktop/src/components/SpreadsheetView.tsx`: restore multi-sheet tabs (`sheetTabs`), add "Open in native app" action, and support "Select Area" confirmation callback.
3. **Step 3: Spreadsheet Links & Full View Modal**
   - In `desktop/src/components/NoteEditor.tsx` and `desktop/src/pages/NotePage.tsx`:
     - Detect spreadsheet links (`.xlsx`, `.csv`, etc.) and open `SpreadsheetModal` on click.
     - Implement `SpreadsheetModal` with auto-save to `PUT /api/notes/image/{name}` and "Open in native app".
4. **Step 4: Editable Spreadsheet Window Widget**
   - Update `desktop/src/components/SpreadsheetWidget.tsx`:
     - Implement picker for attached spreadsheets, file upload, and new spreadsheet creation.
     - Render chosen `displayArea` as an editable grid inline in the note text.
     - Support inline editing, synchronization, and hover controls ("Full view", "Select area", "Open in native app", "Remove").
     - In published mode, hide row and column headers.
5. **Step 5: Assistant Skill Documentation**
   - Update `.gemini/config/skills/spreadsheet_reader/SKILL.md`.
6. **Step 6: Quality Assurance**
   - Run `npm --prefix desktop run build` to verify clean compilation.
   - Run `pytest backend/tests/` to verify all backend tests pass.

---

## 4. User-Driven Manual Testing Plan (Enforced)

The User will verify the changes with the following steps:

1. **Test Spreadsheet Attachment & Link to Full View:**
   - Drag and drop an `.xlsx` file into a note.
   - Verify it appears as a linked pill (e.g. `[budget.xlsx](...)`).
   - Click the link pill.
   - Verify it opens in **Full View Modal**.
   - Verify multi-sheet tabs are present at the bottom (switch tabs, click `+` to add a sheet, double click to rename).
   - In full view, click **"Open in native app"** (or Open in Excel) and verify Microsoft Excel launches with the file.
2. **Test Spreadsheet Widget as an Editable Window:**
   - In the note, type `/spreadsheet` or click the Spreadsheet toolbar button.
   - In the widget's picker, select the attached spreadsheet (or click "Create new").
   - Full view opens to select the display area: drag select `A1:D6` and click "Set display area".
   - The widget now displays that exact `A1:D6` window inside the note body without extra top/bottom margins.
   - Click into a cell in the widget and type a number or formula. Verify it edits inline directly with the note text!
3. **Test Synchronization:**
   - Open full view from the widget or by clicking the spreadsheet link.
   - Verify the edits made in the inline widget are present in full view.
   - Edit a cell in full view, close it, and verify the inline widget updates.
4. **Test Assistant Recognition & Editing:**
   - Open the Co-Pilot chat.
   - Ask the assistant: *"Please read the attached spreadsheet and update cell B2 to 999."*
   - Verify the assistant uses `read_spreadsheet` and `edit_spreadsheet`, updates the file, and confirms the change.
   - Re-open the spreadsheet in the note to confirm cell B2 is updated.
5. **Test Published Mode:**
   - Click "Publish" on the note.
   - Verify the spreadsheet window renders cleanly with row numbers and column letters hidden.
