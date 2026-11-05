# Implementation Plan: Phase 17 — Fix Layout Vertical Expansion Snag

**Task ID:** `phase-17-fix-layout-snag`  
**Git Branch:** `phase-17-tracker-items`  
**Target Roles:**
- **Architect & Reviewer:** Nero (Google Antigravity / Gemini)
- **Implementer:** Jibby (Claude via Claude Code)

---

## 1. Overview & Bug Analysis

### Problem
After implementing Tracker Items 13, 14, 25, 28, and 33, adding a task or opening the task panel causes the layout to appear to grow vertically, leaving a large blank empty space (`#101820` background) below the sidebar and table.

### Root Cause
1. **Window Viewport Scrolling:**
   In the user's screenshot, all three panes (Sidebar, Main task list, and TaskPanel) are scrolled upward off the top of the browser window together by ~250px. The header, logo, space switcher, navigation tabs, and table headers vanished above the screen, while the bottom of the app stopped midway down the window, revealing empty body background underneath.
2. **`min-h-[720px]` on Root Layout:**
   In `desktop/src/components/Layout.tsx`, the root container has `className="flex h-full min-h-[720px] overflow-hidden ..."`.
   When the browser window height is less than 720px (e.g. ~470px on smaller screens, split view, or laptops with UI scaling), `min-h-[720px]` forces the app to be taller than the browser viewport.
3. **Missing `overflow: hidden` on `html, body, #root`:**
   In `desktop/src/index.css`, `html, body, #root` specify `height: 100%`, but lack `overflow: hidden`. As a result, the window becomes vertically scrollable when child content exceeds viewport height.
4. **Focus-Induced Viewport Scroll on Item 13:**
   When a task is created or opened:
   - In `TaskPanel.tsx`, `section.current?.focus({ preventScroll: true })` focuses `<section tabIndex={-1}>` inside `<aside className="animate-pane-in ...">`.
   - In `TaskTable.tsx`, `NewTaskRow` calls `titleInput.current?.focus()` without `{ preventScroll: true }`.
   Because the window was scrollable, the browser scrolled `window.scrollY` down toward the focused element, pushing the app up and exposing a blank gap at the bottom.

---

## 2. Technical Specification & Required Changes

### 1. `desktop/src/index.css`
Lock window/body overflow so the browser window itself can never scroll:
```css
html,
body,
#root {
  height: 100%;
  overflow: hidden;
}
```

### 2. `desktop/src/components/Layout.tsx`
- **Root Container:**
  Remove `min-h-[720px]`. Replace with `min-h-0`:
  ```tsx
  <div
    ref={rootRef}
    className="flex h-full min-h-0 w-full overflow-hidden text-sm leading-[1.45] print:block print:h-auto print:overflow-visible"
  >
  ```
- **Flex Panes:**
  Ensure every column flex item has `h-full min-h-0` so it stretches to fill the exact window height without overflowing:
  - `<nav ref={leftRef}>`: ensure `h-full min-h-0` is present in class list.
  - `<main ref={mainRef}>`: update to `min-w-[320px] min-h-0 flex-1 overflow-auto print:overflow-visible`.
  - `<aside ref={taskRef}>`: update to `flex h-full min-h-0 animate-pane-in flex-col overflow-hidden print:hidden bg-surface-panel motion-reduce:animate-none`.
  - `<aside ref={chatRef}>`: ensure `h-full min-h-0` is present.

### 3. `desktop/src/components/TaskPanel.tsx`
- Ensure the focus effect safely handles scroll prevention and resets any stray window scroll:
  ```tsx
  useEffect(() => {
    if (state.state !== "ok" || focusedId.current === state.task.id) return;
    focusedId.current = state.task.id;
    section.current?.focus({ preventScroll: true });
    if (window.scrollY !== 0) window.scrollTo(0, 0);
  }, [state]);
  ```

### 4. `desktop/src/components/TaskTable.tsx`
- In `NewTaskRow` -> `save()`:
  Pass `preventScroll: true` to `titleInput.current?.focus({ preventScroll: true })`.

### 5. `desktop/src/pages/Tasks.tsx`
- In `KanbanAddCard`:
  Pass `preventScroll: true` to `input.current?.focus({ preventScroll: true })`.

---

## 3. Dev Server Invariants & Implementation Safety

- **Dev Servers Inactivity Rule:** Ensure ports 8000 and 5173 remain STOPPED while Jibby edits files.
- **Branch:** Continue work on branch `phase-17-tracker-items`.

---

## 4. Verification Plan

### Automated Verification
1. Run full backend pytest suite:
   ```powershell
   pytest
   ```
2. Run frontend build & type check:
   ```powershell
   npm --prefix desktop run build
   ```

### Manual User-Driven Verification
1. Start dev servers via `start_tray.cmd`.
2. Open `http://localhost:5173`.
3. Resize the browser window to a small height (e.g. ~500px - 600px).
4. Navigate to **Tasks > List** and **Tasks > Backlog**.
5. Click `+ Add task`, enter a title, and press `Enter` to create a task (triggering Item 13 auto-open and focus).
6. **Verify:**
   - The top header (wordmark, space switcher, tabs, filters) remains fully visible and anchored at the top.
   - The layout fits 100% of the viewport height.
   - There is NO blank space below the sidebar, table, or task panel.
   - The browser window does not scroll.
