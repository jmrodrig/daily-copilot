# Implementation Plan: Phase 14 - Cell Labels (Defined Names) & Multi-Colored Formula References

**Task Identifier:** `phase-14-spreadsheet-cell-labels-and-colored-formulas`  
**Git Branch:** `phase-14-spreadsheet-cell-labels-and-colored-formulas`  
**Related Files:**
- `desktop/src/components/spreadsheet.ts`
- `desktop/src/components/SpreadsheetView.tsx`
- `desktop/src/components/SpreadsheetWidget.tsx`
- `desktop/src/components/workbookStore.ts`
- `backend/read_spreadsheet.py`
- `backend/agent.py`
- `backend/tests/test_agent.py`

---

## 1. Objectives & User Requirements

The user requested two specific spreadsheet enhancements:

1. **(a) Assign Labels/Names to Cells (Excel-Style Defined Names):**
   - Allow assigning labels/names to cells or ranges in a similar fashion as in Excel (Name Box).
   - The Name Box displays the current cell/range address (e.g. `B2`) or its defined name (e.g. `KeelWeight`).
   - The user can click into the Name Box, type a name (e.g., `UnitPrice`, `VAT_Rate`, `TotalCosts`), and press <kbd>Enter</kbd> to assign that name to the selected cell or range.
   - Typing an existing cell address (e.g. `D15`) or defined name into the Name Box and pressing <kbd>Enter</kbd> jumps selection to that cell/range.
   - A dropdown menu on the Name Box lists all defined names in the workbook, allowing jumping to any named range or removing names.
   - In formulas, defined names can be used directly (e.g., `=UnitPrice * VAT_Rate` or `=SUM(Items)`); the formula evaluator resolves them to their values/ranges.
   - Formula autocomplete suggests defined names alongside function names.
2. **(b) Multi-Colored Formula Cell References & Grid Highlights:**
   - When building/editing a formula, each referenced cell or range in the formula gets a distinct color (e.g., Blue, Rose/Red, Purple, Green, Amber, Cyan).
   - On the grid, the corresponding cells/ranges are outlined with matching colored borders and soft background tints.
   - In the formula (both in the in-cell editor and the formula bar `fx`), the corresponding cell IDs/names (`A1`, `B2:C5`, `KeelWeight`) are rendered in those exact same colors.
   - When clicking/dragging on the grid to insert or update references, the newly selected cells and the inserted formula text immediately take on the matching color.

---

## 2. Technical Architecture & Component Design

### A. Data Model & Formula Evaluator (`desktop/src/components/spreadsheet.ts`)

1. **Defined Names Data Structure:**
   ```ts
   export type SpreadsheetData = {
     activeSheet: string;
     sheets: SpreadsheetSheet[];
     title?: string;
     names?: Record<string, string>; // e.g. { "KeelWeight": "Sheet1!B2", "Prices": "A1:A10" }
   };
   ```
2. **Defined Name Helpers:**
   - `isValidDefinedName(name: string): boolean`: checks name starts with a letter or underscore (`/^[A-Za-z_][A-Za-z0-9_.]*$/`) and is not a valid cell address (e.g. not `A1`, `BC10`).
   - `resolveDefinedName(data: SpreadsheetData, name: string): { sheet: string | null; range: CellRange } | null`:
     Case-insensitive lookup in `data.names`, returns sheet name and bounding `CellRange`.
   - `findDefinedNameForRange(data: SpreadsheetData, sheetName: string, range: CellRange): string | null`:
     Returns the first defined name pointing to this exact range on `sheetName` (if any).
3. **Formula Evaluator (`createEvaluator`):**
   - When tokenizing an identifier `name` (not followed by `(`):
     - Check `resolveDefinedName(data, name)`.
     - If it resolves to a single cell: evaluate and return that cell's value.
     - If it resolves to a range: return the array of values from that range (so functions like `SUM(Prices)` or `AVERAGE(Items)` evaluate seamlessly).
4. **Formula References & Color Palette:**
   - Define a fixed cycle of distinct high-contrast colors matching Excel's aesthetic:
     ```ts
     export type FormulaColor = {
       id: string;
       border: string; // Tailwind border or hex
       bg: string;     // Tailwind background or rgba
       text: string;   // Tailwind text class or hex
       hex: string;
     };
     export const FORMULA_PALETTE: FormulaColor[] = [
       { id: "blue", border: "border-blue-500", bg: "bg-blue-500/10", text: "text-blue-500", hex: "#3b82f6" },
       { id: "rose", border: "border-rose-500", bg: "bg-rose-500/10", text: "text-rose-500", hex: "#f43f5e" },
       { id: "purple", border: "border-purple-500", bg: "bg-purple-500/10", text: "text-purple-500", hex: "#a855f7" },
       { id: "emerald", border: "border-emerald-500", bg: "bg-emerald-500/10", text: "text-emerald-500", hex: "#10b981" },
       { id: "amber", border: "border-amber-500", bg: "bg-amber-500/10", text: "text-amber-500", hex: "#f59e0b" },
       { id: "cyan", border: "border-cyan-500", bg: "bg-cyan-500/10", text: "text-cyan-500", hex: "#06b6d4" },
     ];
     ```
   - Enhance `formulaReferences`:
     ```ts
     export type ColoredFormulaRef = {
       sheet: string | null;
       range: CellRange;
       rawText: string;
       start: number; // string index in formula
       end: number;   // string index in formula
       colorIndex: number;
     };
     export function formulaColoredReferences(formula: string, currentSheet: string, names?: Record<string, string>): ColoredFormulaRef[]
     ```
     Walks tokens; each `ref` or resolved defined `name` gets an incrementing `colorIndex`.
5. **SheetJS Integration:**
   - `parseWorkbookBuffer`: reads `book.Workbook?.Names` into `data.names`.
   - `exportWorkbook`: converts `data.names` into `book.Workbook.Names` so Excel preserves names when exported.

---

### B. Name Box Component (`desktop/src/components/SpreadsheetView.tsx`)

1. **Interactive Name Box:**
   - Positioned to the left of `fx` formula bar.
   - Display:
     - If the currently selected range matches an entry in `data.names`, display that name (e.g. `KeelWeight`).
     - Otherwise, display the coordinate (e.g. `B2` or `B2:D6`).
   - Editing / Assigning:
     - User clicks or focuses the Name Box and types a name (e.g. `TaxRate`).
     - Pressing <kbd>Enter</kbd>:
       - If valid name: assigns `data.names[name] = ...` referencing the current range on the active sheet. Commits data.
       - If existing cell address (e.g. `E10`) or existing defined name (e.g. `KeelWeight`): jumps the selection to that cell/range and scrolls it into view.
       - <kbd>Esc</kbd> cancels.
   - Dropdown Menu:
     - Dropdown arrow button opens a popover list of all defined names in the workbook.
     - Clicking a name selects that range and closes the popover.
     - A delete icon (`✕`) on each row allows deleting that defined name.

---

### C. Synchronized Multi-Colored Formula Highlighting (`SpreadsheetView.tsx`)

1. **Grid Border & Tinting:**
   - For all active references in the current formula (from `formulaColoredReferences`), map each reference to its color in `FORMULA_PALETTE`.
   - On the grid cells:
     - Instead of the single accent color, apply the specific reference's `border` color for perimeter edges.
     - Apply subtle background tint (`bg`) for cells inside the range.
2. **Formula Text Syntax Highlighting in Inputs:**
   - Both in the **Formula Bar (`fx`)** and **In-Cell Editor**:
     - Render a syntax-highlighting text layer aligned with the `<input>`.
     - When a formula begins with `=`:
       - Text before/after references is standard `text-text-primary`.
       - Reference tokens (`A1`, `B2:C5`, `KeelWeight`) are rendered in `<span>`s with matching `ref.color.hex` and font weight 600.
       - The native input sits directly over it with `text-transparent caret-text-primary bg-transparent`, allowing seamless native typing, arrow keys, and cursor selection while visually displaying the rich colors.
       - When not editing, the formula bar displays the colored formula text directly.
3. **Interactive Grid Picking with Colors:**
   - When the user clicks or drags on the grid while authoring a formula:
     - The inserted address/range is tokenized and immediately highlighted on the grid with its assigned color.
     - The corresponding characters in the formula bar and cell editor reflect that same color instantly.

---

### D. Backend & Agent Support (`backend/read_spreadsheet.py`, `backend/agent.py`)

1. **Agent Tool (`edit_spreadsheet`):**
   - Accept optional `names?: dict[str, str]` parameter to define or remove names (e.g. `names={"KeelWeight": "B2"}`).
2. **Backend Tests:**
   - Add unit tests verifying `names` in `read_spreadsheet` and `edit_spreadsheet`.

---

## 3. Implementation Steps for Jibby

1. **Step 1: Data Model, Name Resolution & Colored References (`spreadsheet.ts`)**
   - Add `names` to `SpreadsheetData` and `parseSpreadsheet`.
   - Add `isValidDefinedName`, `resolveDefinedName`, `findDefinedNameForRange`.
   - Update `createEvaluator` to resolve defined names in formula evaluation.
   - Add `FORMULA_PALETTE` and `formulaColoredReferences`.
   - Update `functionSuggestions` to suggest defined names.
   - Add SheetJS import/export for workbook names.
2. **Step 2: Excel-Style Name Box (`SpreadsheetView.tsx`)**
   - Replace static coordinate span with interactive Name Box (input + dropdown).
   - Support typing new name to assign, typing coordinate/name to jump.
   - Dropdown list to jump to or delete defined names.
3. **Step 3: Multi-Colored Formula Cell Selection & Text Highlighting (`SpreadsheetView.tsx`)**
   - Update grid cell rendering to draw colored borders and tinted backgrounds matching each reference's palette color.
   - Add syntax-highlighting color overlay for formula bar and in-cell input so cell IDs render in matching colors.
4. **Step 4: Quality Assurance**
   - Verify frontend compiles cleanly: `npm --prefix desktop run build`.
   - Verify backend test suite passes: `pytest backend/tests/`.

---

## 4. User-Driven Manual Testing Plan (Enforced)

The User will verify the changes with the following steps:

1. **Test Name Box (Assigning Cell Labels):**
   - Open a spreadsheet in full view.
   - Select cell `B2` and enter `150`.
   - Click into the Name Box (left of `fx`). Type `KeelWeight` and press <kbd>Enter</kbd>.
   - Verify the Name Box now displays `KeelWeight` whenever cell `B2` is selected.
   - Select another cell (e.g. `D5`), click the Name Box dropdown arrow, and click `KeelWeight`.
   - Verify selection immediately jumps back to cell `B2`.
2. **Test Using Defined Names in Formulas:**
   - In cell `C2`, type `=KeelWeight * 1.2` and press <kbd>Enter</kbd>.
   - Verify the formula evaluates to `180`.
   - In cell `C3`, start typing `=K` and verify `KeelWeight` appears in the autocomplete suggestion list.
3. **Test Multi-Colored Formula References:**
   - In cell `D1`, type `=`.
   - Click cell `B2` (or type `B2`). Verify `B2` is colored in **Blue** in the formula and outlined in **Blue** on the grid.
   - Type `+`.
   - Click cell `C2` (or type `C2`). Verify `C2` is colored in **Rose/Red** in the formula and outlined in **Rose/Red** on the grid.
   - Type `+ SUM(`.
   - Drag across cells `A1:A3`. Verify `A1:A3` is colored in **Purple** in the formula and outlined in **Purple** on the grid.
   - Press <kbd>Enter</kbd> to confirm the formula.
   - Select cell `D1` again: look at the formula bar and verify the different cell references (`B2`, `C2`, `A1:A3`) appear with their distinct colors matching the grid outlines.
4. **Test Name Deletion:**
   - Open the Name Box dropdown, click the `✕` next to `KeelWeight`.
   - Verify the name is removed and cell `B2` shows as `B2` again.
