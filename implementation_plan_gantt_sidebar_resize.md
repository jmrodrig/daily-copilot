# Implementation Plan: Adjustable Gantt Label Column

## Goal
Make the left-most column (the task/project names column) in the Gantt chart adjustable in width, allowing users to expand it to read long task names or collapse it to see more of the timeline.

## Implementation Steps (`desktop/src/components/GanttChart.tsx`)

### 1. State Management
- Remove the top-level constant `const LABEL_W = 240;`.
- Add a new local state inside the `GanttChart` component: `const [labelW, setLabelW] = useState(240);`.
- Ensure that helper functions (like `dayAt` and the auto-scroll drag calculations) now correctly reference the dynamic `labelW` from state rather than a static constant.

### 2. Resizer Handle UI
- Introduce a vertical resize handle on the right edge of the sticky left column. This is best placed in the main flex container or mapped cleanly onto the border. 
- Use standard `cursor-col-resize`.
- The handle should span the full height of the Gantt chart or be attached to the sticky column header/cells so that dragging it adjusts the width.
- You can place a thin `div` over the border-r of the sticky column that acts as the hit area for resizing.

### 3. Drag Logic
- Implement `onPointerDown`, `window.addEventListener('pointermove')`, and `pointerup` (or similar drag mechanics) specifically for this handle to update `setLabelW`.
- Add min/max constraints (e.g., minimum 150px, maximum 800px) to prevent breaking the layout.
- During drag, temporarily set `user-select: none` or prevent default behavior to avoid text selection issues.

### 4. Code Checks
- Make sure that all inline styles referencing `LABEL_W` are updated to use `labelW`.
- Check `Row` and other child components that might be using `LABEL_W` (pass `labelW` down as a prop if necessary).
