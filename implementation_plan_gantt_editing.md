# Implementation Plan: Interactive Gantt Chart (v7)

## Overview
Transform the read-only Gantt chart (`desktop/src/components/GanttChart.tsx`) into an interactive planning tool.
Users must be able to select tasks, drag them to change dates, resize them to change durations, and shift the entire timeline from a specific reference date via a new dialog.

## 1. Bulk Selection & Highlighting
- **Selection State:** Add local state (e.g., `Set<number>`) to track selected task IDs in the Gantt chart.
- **UI:** 
  - Add checkboxes to the left-hand task list (the frozen column).
  - Support Ctrl+Click (Cmd+Click on Mac) and Shift+Click on task rows/bars to add to selection, matching standard OS behavior.
  - Highlight selected rows/bars visually.

## 2. Drag & Resize Tasks (Pointer Events)
- **Mechanics:** 
  - Use `onPointerDown`/`Move`/`Up` to handle dragging on the `<Bar>` component.
  - Left edge of the bar (`cursor: ew-resize`): Modifies `start_date`.
  - Right edge of the bar (`cursor: ew-resize`): Modifies `due_date` (deadline).
  - Middle of the bar (`cursor: grab`): Shifts both dates by the same delta.
- **Bulk Dragging:** If the dragged task is part of a multiple selection, apply the exact same day-delta to all selected tasks simultaneously.
- **Optimistic UI:** Update the positions locally during the drag for a smooth 60fps feel.
- **Persistence:** On `onPointerUp`, calculate the new dates and call the existing `onPatch` (or `POST /api/tasks/bulk-update`) with the affected `TaskPatch` dictionaries.

## 3. Timeline Shifting (Vertical Cursor & Dialog)
- **Vertical Chart Cursor:** 
  - Hovering over the Gantt grid should render a vertical line at the hovered date.
  - Clicking locks the cursor and renders a "Shift" icon button at the top of the line.
- **Shift Dialog (`GanttShiftDialog.tsx`):**
  - Clicking the icon opens a modal dialog.
  - **Inputs:**
    - Shift by [ N ] days [ forward | backward ]
    - Shift to [ specific date picker ]
    - Shift to Today (button)
    - Checkbox: "Shift only future dates (including due dates of already started tasks)" [Checked by default].
  - **Logic (Calculated on Frontend):** 
    - The `reference_date` is the date the vertical cursor was locked on.
    - Calculate the day delta.
    - If "Shift only future dates" is checked:
      - For each task in the visible Gantt chart:
        - If `start_date >= reference_date`: shift both `start_date` and `deadline`.
        - If `start_date < reference_date` but `deadline >= reference_date`: shift ONLY `deadline`.
        - If `deadline < reference_date`: do not shift.
    - If unchecked, shift `start_date` and `deadline` for ALL visible tasks.
    - Build a bulk update payload for all affected tasks and submit it.
- **No Backend Changes Needed:** Rely on the existing `bulk-update` task API endpoint. Just pass the calculated dates.
