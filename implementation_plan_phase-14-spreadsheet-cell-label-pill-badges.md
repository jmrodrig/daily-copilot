# Implementation Plan: Phase 14 - Cell Label Pill Badges (Custom Cell Names Display)

**Task Identifier:** `phase-14-spreadsheet-cell-label-pill-badges`  
**Git Branch:** `phase-14-spreadsheet-cell-label-pill-badges`  
**Related Files:**
- `desktop/src/components/spreadsheet.ts`
- `desktop/src/components/SpreadsheetView.tsx`
- `desktop/src/components/SpreadsheetWidget.tsx`

---

## 1. Objectives & User Requirements

The user requested:
> *"Look into adding a label to cells with a custom name as sketch in the screenshot. If feasible, plan and deploy jibby"*

### Visual Analysis of the User's Screenshot:
- The screenshot shows an in-note spreadsheet widget (note view) with rows 1 to 12 and columns A to F.
- In cell **B4**, the user hand-drew in cyan a rounded tag / pill containing the label `M_Keel` on the left side of the cell, with the cell value `246` on the right side.
- When a cell has an assigned custom name / label (via Excel defined names / Name Box), that label should be visibly displayed inside the cell as a compact rounded badge / pill tag, coexisting cleanly with the cell's value.

---

## 2. Technical Architecture & Component Design

### A. Cell Label Resolution & Mapping (`spreadsheet.ts`, `SpreadsheetView.tsx`)

1. **Cell-Level Name Lookup (`useMemo`):**
   - In `SpreadsheetView.tsx`, compute a fast `Map<string, string>` mapping `"row:col"` coordinates on the currently viewed sheet to defined names:
     ```ts
     const cellLabels = useMemo(() => {
       const map = new Map<string, string>();
       if (!data.names) return map;
       for (const [name, ref] of Object.entries(data.names)) {
         const target = parseNameRef(ref);
         if (!target) continue;
         const onSheet = target.sheet === null || target.sheet.toLowerCase() === sheetName.toLowerCase();
         if (!onSheet) continue;
         // Single cell defined name
         if (target.range.r1 === target.range.r2 && target.range.c1 === target.range.c2) {
           map.set(`${target.range.r1}:${target.range.c1}`, name);
         }
       }
       return map;
     }, [data.names, sheetName]);
     ```
   - O(1) retrieval per cell: `const cellLabel = cellLabels.get(`${r}:${c}`);`

### B. Inline Cell Label Badge Rendering (`SpreadsheetView.tsx`)

1. **Badge Appearance (matching the screenshot's cyan sketch):**
   - Styled to match the cyan rounded pill drawn in the user's screenshot:
     ```tsx
     <span
       className="shrink-0 rounded border border-cyan-500/60 bg-cyan-500/10 px-1 py-0.5 font-mono text-[10px] font-medium leading-none text-cyan-400 select-none max-w-[55%] truncate cursor-default"
       title={`Cell label: ${cellLabel}`}
     >
       {cellLabel}
     </span>
     ```
2. **Cell Layout with Value:**
   - When not in active text-editing mode:
     - If `cellLabel` exists:
       Render a flex container inside `<td>`:
       ```tsx
       <div className="flex h-full w-full items-center justify-between gap-1 overflow-hidden">
         <span className="shrink-0 rounded border border-cyan-500/60 bg-cyan-500/10 px-1 py-0.5 font-mono text-[10px] font-medium leading-none text-cyan-400 select-none max-w-[55%] truncate" title={`Cell label: ${cellLabel}`}>
           {cellLabel}
         </span>
         <span className="flex-1 truncate" style={{ textAlign }}>
           {shown}
         </span>
       </div>
       ```
     - If the cell value is empty, the label still renders on the left, so labeled placeholder cells are clearly identifiable.
     - Visible in both Note View (compact) and Full View, and retained in published mode so notes are self-documenting.

### C. Direct Label Editing & Context Action

1. **Quick Label Assignment in Note View / Full View:**
   - In full view, users can already assign names via the Name Box.
   - To make it just as easy in note view (which doesn't have a formula bar):
     - Clicking on an existing label pill in editable mode opens a small prompt/popover to rename or remove the label.
     - Right-clicking a cell (or a context menu / hotkey like `F2` or context menu) in editable mode offers a **"Set cell label..."** option, prompting for a name and saving it to `data.names`.
     - Deleting a label: entering empty text removes the label from `data.names`.

---

## 3. Implementation Steps for Jibby

1. **Step 1: Cell Label Mapping in `SpreadsheetView.tsx`**
   - Add `cellLabels` memoized map from `"r:c"` to defined name for the active sheet.
2. **Step 2: Render Cyan Pill Badge inside Labeled Cells**
   - Update `<td>` non-editing render branch to display the cyan pill badge on the left side of the cell and the value on the right, matching the user's sketch.
   - Ensure text truncation and layout remain clean and don't overflow the cell.
3. **Step 3: Direct Click / Context Menu for Cell Labels**
   - Clicking an existing label badge in editable mode prompts to edit/delete the label.
   - Add a context menu or right-click handler on cells allowing "Set cell label" / "Remove label" directly in both note view and full view.
4. **Step 4: Quality Assurance**
   - Run `npm --prefix desktop run build` to verify frontend build passes cleanly.
   - Run `pytest backend/tests/` to verify no regressions.

---

## 4. User-Driven Manual Testing Plan (Enforced)

The User will verify the changes with the following steps:

1. **Verify Pill Badge Display (as in screenshot):**
   - In any note with a spreadsheet, select cell `B4` and enter `246`.
   - Assign the name `M_Keel` to cell `B4` (via Name Box in full view or right-clicking cell B4 -> Set cell label).
   - In the note view, look at cell `B4`:
     - Verify a rounded cyan pill badge `M_Keel` appears on the left side of the cell.
     - Verify the number `246` appears on the right side of the cell, exactly matching the screenshot sketch.
2. **Test Multiple Labeled Cells:**
   - Assign `Length` to cell `B3` with value `123`.
   - Verify cell `B3` shows `[Length] 123` with the badge on the left.
3. **Test Editing and Removal:**
   - Click the `M_Keel` badge in editable mode.
   - Rename it to `Keel_Mass` (or clear it).
   - Verify the badge updates immediately (or disappears if cleared).
4. **Test Formulas and References:**
   - In another cell, type `=M_Keel * 2` and verify it calculates `492`.
5. **Test Published Mode:**
   - Click "Publish" on the note.
   - Verify the cell label badges remain clearly visible in published view, making the data in the note self-documenting.
