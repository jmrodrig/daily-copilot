# Implementation Plan: Simplify Gantt Shift Interface

## Overview
Based on user feedback, the Gantt chart shift interface needs simplification. The two-step process of clicking to "lock" a cursor and then clicking "Shift" is too cumbersome. We will eliminate the fixed cursor concept entirely and integrate the shift action directly onto the floating hover cursor.

## Requirements
1. **Eliminate the Fixed Cursor:** Remove the `lockedDay` state and its associated UI elements (the yellow locked line and the unlock `(x)` button).
2. **Move Shift Button to Hover Cursor:** Attach the shift button (the one with the `ShiftIcon`) directly to the floating cursor (`hoverDay`). When hovered, the user should be able to click this button on the line itself.
3. **Remove Toolbar Shift Button:** Remove the secondary "Shift from..." button that appeared in the top-right toolbar.

## Implementation Steps (`desktop/src/components/GanttChart.tsx`)

### 1. State Management
- Remove `const [lockedDay, setLockedDay] = useState<number | null>(null);`
- Change `const [shifting, setShifting] = useState(false);` to `const [shiftAnchor, setShiftAnchor] = useState<number | null>(null);`.
- Update `onGridClick` to remove the `setLockedDay` call.
- Update the `Escape` key handler to remove references to `lockedDay`. (Leave the `selected` clearance).

### 2. Toolbar Cleanup
- In the toolbar (`role="toolbar"`), remove the conditional block that renders the "Shift from..." button (`lockedDay !== null && ...`).

### 3. Hover Cursor (`hoverDay`) Updates
- Change the `hoverDay !== null` rendering block.
- Keep the hover vertical line and the background highlight.
- Replace the plain `<span>` date label with a `pointer-events-auto` container containing the Shift button.
- Make it visually cohesive (e.g., a nice pill shape containing the date and the shift icon).
- When the Shift button is clicked, call `setShiftAnchor(hoverDay)`.
- *Note:* Since the parent container of the cursors has `pointer-events-none` (to not block dragging), ensure the new Shift button has `pointer-events-auto` and `data-gantt-control` so it can be clicked.

### 4. Dialog Integration
- Render `<GanttShiftDialog>` conditionally when `shiftAnchor !== null`.
- Pass `reference={shiftAnchor}` instead of `lockedDay`.
- Update the `onClose` callback to `setShiftAnchor(null)`.
