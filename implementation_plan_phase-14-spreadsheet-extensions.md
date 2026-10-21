# Implementation Plan: Phase 14 - Spreadsheet Extensions & Formula UX

**Task Identifier:** `phase-14-spreadsheet-extensions`  
**Git Branch:** `phase-14-spreadsheet-extensions`  
**Related Files:**
- `desktop/src/components/spreadsheet.ts`
- `desktop/src/components/SpreadsheetView.tsx`
- `desktop/src/components/SpreadsheetWidget.tsx`
- `desktop/src/components/NoteEditor.tsx`
- `desktop/src/pages/NotePage.tsx`
- `desktop/src/components/noteFormatting.ts`

---

## 1. Objectives & User Requirements

1. **(a) Extend Displayed Columns Past Edge in Full View:**
   In full-size view (`!compact`), displayed columns must extend past the right edge of the viewport / screen on all displays, providing a continuous, horizontally scrollable Excel-like canvas rather than truncating at the data boundary.
2. **(b) Note Display Area (Print Area Selection):**
   Allow configuring a "Display Area" inside the full view (similar to Excel's "Set Print Area"). The user can select a range of cells (e.g., `A1:E8`) and mark it as the display area. On the note/canvas view, only the selected rows and columns are rendered.
3. **(c) Formula Autocomplete & Interactive Cell Selection:**
   - **Autocomplete:** When typing a formula (starting with `=`), show an autocomplete dropdown for available functions (`SUM`, `AVERAGE`, `COUNT`, `MIN`, `MAX`, `ROUND`, `ABS`) with syntax and descriptions. Arrow navigation and Tab/Enter inserts `FUNCTION(`.
   - **Interactive Grid Picking:** While authoring a formula (after `=`, `(`, `,`, `+`, `-`, `*`, `/`), clicking a grid cell inserts its coordinate (e.g., `B2`), and dragging across cells inserts or updates a range (e.g., `B2:B8`) with visual marching ants / highlighted outline on the grid.
4. **(d) Remove Multiple Sheet Option:**
   Remove the bottom sheet tabs bar, sheet addition (`+`), sheet renaming, and sheet deletion. The spreadsheet acts strictly as a single-sheet workbook while maintaining backwards-compatible JSON schema.
5. **(e) Compact Note View Styling & Published Mode:**
   - On notes, remove top title bars and empty bottom/top margins: hug the cell area neatly (`h-auto`, no fixed `h-[300px]` with blank margins).
   - In draft/editable note view (`editable === true`): show column letters (`A`, `B`, `C`...) and row numbers (`1`, `2`, `3`...).
   - In published/read-only view (`editable === false`): hide the column letters and row number headers completely, showing only the clean cell table.

---

## 2. Technical Design & Architecture

### A. Data Model & Helpers (`spreadsheet.ts`)
1. Extend `SpreadsheetSheet`:
   ```ts
   export type SpreadsheetSheet = {
     name: string;
     rows: string[][];
     styles?: Record<string, SpreadsheetStyle>;
     displayArea?: string; // e.g. "A1:D8" or undefined (default)
   };
   ```
2. Helper functions:
   - `parseRangeAddress(rangeStr: string): { r1: number; c1: number; r2: number; c2: number } | null`
   - `formatRangeAddress(r1: number, c1: number, r2: number, c2: number): string`
   - `getEffectiveDisplayRange(sheet: SpreadsheetSheet): { r1: number; c1: number; r2: number; c2: number }`:
     - If `sheet.displayArea` is set and valid, parse and return `r1, c1, r2, c2`.
     - Otherwise, compute bounding box of used cells (or fallback to `r1: 0, c1: 0, r2: Math.max(sheet.rows.length - 1, 0), c2: Math.max(sheetCols(sheet) - 1, 0)`).
3. Export catalog of formula functions:
   ```ts
   export type FormulaFunctionInfo = {
     name: string;
     syntax: string;
     description: string;
   };
   export const FORMULA_FUNCTIONS: FormulaFunctionInfo[] = [
     { name: "SUM", syntax: "SUM(number1, [number2], ...)", description: "Adds all numbers in a range." },
     { name: "AVERAGE", syntax: "AVERAGE(number1, [number2], ...)", description: "Calculates the arithmetic mean of numbers in a range." },
     { name: "COUNT", syntax: "COUNT(value1, [value2], ...)", description: "Counts cells that contain numbers." },
     { name: "MIN", syntax: "MIN(number1, [number2], ...)", description: "Returns the smallest number in a range." },
     { name: "MAX", syntax: "MAX(number1, [number2], ...)", description: "Returns the largest number in a range." },
     { name: "ROUND", syntax: "ROUND(number, num_digits)", description: "Rounds a number to a specified number of digits." },
     { name: "ABS", syntax: "ABS(number)", description: "Returns the absolute value of a number." },
   ];
   ```

### B. Full Size View Updates (`SpreadsheetView.tsx`)
1. **Viewport-filling Grid Width (Requirement a):**
   - For full view (`!compact`):
     Compute `colCount`:
     `const fullMinCols = Math.max(26, Math.ceil((typeof window !== "undefined" ? window.innerWidth : 1920) / COL_W) + 5);`
     `const colCount = canEdit ? Math.max(usedCols + 15, fullMinCols) : usedCols;`
     `const rowCount = canEdit ? Math.max(usedRows + 25, 60) : usedRows;`
     This guarantees columns stretch well past the screen edge on any monitor width with continuous horizontal scroll.
2. **Remove Multiple Sheet Option (Requirement d):**
   - Remove `sheetTabs` DOM element.
   - Remove `renaming`, `addSheet`, `deleteSheet`, `finishRename`.
   - All operations operate strictly on `data.sheets[0]`.
3. **Display Area / Print Area Control (Requirement b):**
   - In toolbar, add a "Display Area" button / menu:
     - "Set Display Area" (sets `sheet.displayArea` to `${cellAddress(range.r1, range.c1)}:${cellAddress(range.r2, range.c2)}`).
     - "Clear Display Area" (clears `sheet.displayArea` back to `undefined`).
     - When active, show a badge or chip: `Display: A1:D8 [✕]`.
   - Grid rendering in full view:
     - If `sheet.displayArea` is set, render a dashed outline around the perimeter cells of the display area (e.g. `border-t-2 border-dashed border-accent`, etc.) so the user clearly sees the note preview boundaries.
4. **Formula Autocomplete (Requirement c):**
   - When editing a cell or formula bar:
     - Detect if value starts with `=` and cursor is on an alphanumeric function prefix (e.g. `=S`, `=AV`).
     - Filter `FORMULA_FUNCTIONS` by prefix.
     - Display a floating autocomplete dropdown with keyboard navigation (ArrowUp, ArrowDown, Tab, Enter to accept, Esc to dismiss).
     - Accepting replaces the typed prefix with `FUNCTION(` and positions cursor.
5. **Interactive Grid Cell Selection during Formula Authoring (Requirement c):**
   - Detect if formula is currently awaiting a cell reference (ends with `=`, `(`, `,`, `+`, `-`, `*`, `/` or has an active range selection token).
   - Clicking a cell inserts e.g. `B2`.
   - Dragging across cells inserts or updates e.g. `B2:B8`.
   - Render animated or colored dashed border (marching ants) around the referenced cells on the grid.

### C. Note / Compact View Styling & Published View (`SpreadsheetWidget.tsx`, `SpreadsheetView.tsx`)
1. **Display Area in Compact View (Requirement b & e):**
   - In `compact` mode, compute effective range:
     `const { r1, c1, r2, c2 } = getEffectiveDisplayRange(current);`
     Render ONLY rows `r1..r2` and columns `c1..c2`!
   - Table width and height fit this exact range snugly.
2. **No Top/Bottom Margins (Requirement e):**
   - Remove fixed `h-[300px]` from `SpreadsheetFrame`.
   - Replace with `h-auto w-fit max-w-full overflow-auto` so the widget hugs the table.
   - Remove inner toolbar header from `SpreadsheetView` in `compact` mode.
   - Place an expand/fullscreen button (and remove button if editable) as a subtle corner overlay on hover in `SpreadsheetFrame`.
   - Double-clicking any cell in compact view opens full view.
3. **Header Visibility in Published Mode (Requirement e):**
   - In `compact` mode:
     - If `editable === true` (note editor / draft mode): keep row numbers `r+1` and column letters `colLetter(c)`.
     - If `editable === false` (note viewer / published mode): hide `<thead />` and `<th scope="row" />`! Only render `<td />` cells.

---

## 3. Implementation Steps for Jibby

1. **Step 1: Data Model (`desktop/src/components/spreadsheet.ts`)**
   - Add `displayArea?: string` to `SpreadsheetSheet`.
   - Add `parseRangeAddress`, `formatRangeAddress`, `getEffectiveDisplayRange`.
   - Add `FORMULA_FUNCTIONS` list and helper functions.
2. **Step 2: Update `SpreadsheetView.tsx`**
   - Extend column count to fill viewport width + buffer.
   - Remove sheet tabs and multi-sheet actions.
   - Add "Set Display Area" / "Clear Display Area" toolbar controls and dashed outline overlay.
   - Add formula autocomplete popup with keyboard navigation.
   - Add cell clicking / drag range selection while editing formulas with marching ants / selection outline.
   - Implement `displayArea` cell filtering in `compact` mode.
   - Conditionally hide row/column header elements when `compact && !editable`.
3. **Step 3: Update `SpreadsheetWidget.tsx`**
   - Remove fixed `h-[300px]` and top header bar in compact mode.
   - Hug table dimensions cleanly without top or bottom whitespace margins.
   - Add subtle floating expand icon on hover or top right.
4. **Step 4: Quality Assurance**
   - Run `npm --prefix desktop run build` to verify clean TypeScript compilation and bundle generation.
   - Run `pytest backend/tests/` to verify no regressions.

---

## 4. User-Driven Manual Testing Plan (Enforced)

The User will verify the changes with the following steps:

1. **Test Full Size Column Extension:**
   - In any note, type `/spreadsheet` or click the Spreadsheet button.
   - Click the expand icon to open the full view.
   - Verify columns extend well past the right edge of the screen (past column Z / scrolling horizontally), with no cut-off table.
2. **Test Display Area Selection:**
   - In full view, type values into `A1:C3`.
   - Select cells `A1:B2`.
   - Click "Set Display Area" in the toolbar. Verify a dashed outline appears around `A1:B2`.
   - Press Esc to return to the note view.
   - Verify the note view now displays ONLY cells `A1:B2` (columns A-B, rows 1-2).
3. **Test Formula Autocomplete & Cell Range Picking:**
   - Open full view. In cell `C1`, type `=S`.
   - Verify an autocomplete menu appears with `SUM`. Press Tab or Enter to select it -> `=SUM(` is entered.
   - Click and drag across `A1:B2`. Verify `=SUM(A1:B2)` appears in the formula and `A1:B2` has a dashed highlight.
   - Press Enter. Verify the formula evaluates to the sum of those cells.
4. **Test Single Sheet Only:**
   - Verify there is no bottom sheet tabs bar, no `+` add sheet button, and no sheet rename/delete controls.
5. **Test Note View Hugging & Published Mode:**
   - In the note editor, verify the spreadsheet frame has no empty vertical gap/margins at the top or bottom; it wraps the cell table snugly.
   - Verify column letters (A, B) and row numbers (1, 2) are visible while editing.
   - Publish the note (click Publish).
   - In published mode, verify the column letters (A, B) and row numbers (1, 2) are completely hidden, showing only the clean cell data.
