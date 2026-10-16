# Implementation Plan: Fix Copilot Chat Resizing and Drag Ergonomics

**Branch:** `feat/fix-chat-resize-ergonomics` (or current active branch)  
**Target Component:** `desktop/src/components/Layout.tsx`

---

## 1. Problem Summary & Investigation Findings

The resizing handle for the Co-pilot chat panel is perceived as "difficult to drag" and frequently appears stuck or unresponsive. Investigation with Playwright automated instrumentation and code analysis revealed **four distinct root causes**:

### Root Cause 1: Dead Zone on Default Width (`chat.min === 400`)
- In `Layout.tsx`, `PANES.chat` is defined as:
  ```ts
  chat: { initial: 400, min: 400, max: 1200 }
  ```
- Because `initial === min === 400`, the chat panel opens at its minimum width.
- When a user clicks the divider and drags to the **right** (to make the chat narrower and give more room to the document/board), `clamp("chat", ...)` enforces `Math.max(400, 400 - dx) === 400`.
- The panel **cannot be made even 1 pixel narrower**. To the user, dragging to the right feels completely broken and unresponsive.
- In `resizeTaskAndChat` (when both Task Panel and Chat are open), `hi = Math.min(PANES.task.max - s.task, s.chat - PANES.chat.min)` evaluates to `0`, making it impossible to drag the task/chat border to the right as well.

### Root Cause 2: Viewport Clamping Freezes Expansion (`MAIN_MIN = 400`)
- In `resizeAgainstMain`:
  ```ts
  const room = Math.max(0, s.main - MAIN_MIN);
  setWidths((prev) => ({ ...prev, [pane]: clamp(pane, s[pane] + Math.min(grow, room)) }));
  ```
- On standard screen resolutions (1024px, 1150px, 1280px, or split-screen windows) or whenever a Task panel is open alongside the chat:
  `s.main` is at or below 400px.
- Consequently, `room = 0`.
- When `room = 0`, `Math.min(grow, 0) = 0`, meaning dragging to the **left** (to expand the chat) is completely blocked.
- Combined with Root Cause 1, on viewports where `s.main <= 400px`, the chat divider is **completely frozen in both directions** (0px left, 0px right).

### Root Cause 3: Asymmetrical & Tiny 7px Hit Area (`left-0 -right-1.5`)
- In `Divider`:
  ```tsx
  <div className="absolute inset-y-0 left-0 -right-1.5" />
  ```
- The outer divider line is 1px wide (`w-px`). The inner invisible grip has `left-0` and `-right-1.5` (right: -6px).
- This creates an asymmetrical 7px hit target positioned **entirely to the right** of the border line.
- Tolerance to the left of the border is **0px**: if the cursor is even 1px or 2px to the left of the line (the natural trajectory when moving from the main document to the divider), `cursor: col-resize` does not show, and clicking clicks the document body/editor instead of grabbing the handle.

### Root Cause 4: Pointer Slippage & Text Selection During Drag
- While dragging, `user-select: none` is not applied at the document level.
- If the mouse moves quickly across the screen or pointer capture drops momentarily during React state updates, the browser initiates text selection on note contents, causing the cursor to flicker between `col-resize` and `text`, interrupting the drag motion.

---

## 2. Implementation Steps for the Implementer

### Step 1: Update Pane Constraints in `desktop/src/components/Layout.tsx`
1. Change `PANES.chat.min` from `400` to `320`:
   ```ts
   chat: { initial: 400, min: 320, max: 1200 },
   ```
   *(Verified via Playwright testing: `CopilotChat` has zero horizontal overflow, adapts cleanly, and wraps action buttons properly down to 280px).*
2. Adjust `MAIN_MIN` from `400` to `320` and align `<main>` class `min-w-[320px]`:
   ```ts
   const MAIN_MIN = 320;
   ```
   ```tsx
   <main ref={mainRef} className="min-w-[320px] flex-1 overflow-auto print:overflow-visible">
   ```
3. Update `resizeAgainstMain` so shrinking is never blocked by `room`:
   ```ts
   function resizeAgainstMain(pane: Pane, grow: number) {
     const s = start.current;
     // When shrinking (grow < 0), room is not a constraint; when expanding (grow > 0), respect main's minimum.
     const room = Math.max(0, s.main - MAIN_MIN);
     const delta = grow > 0 ? Math.min(grow, room) : grow;
     setWidths((prev) => ({ ...prev, [pane]: clamp(pane, s[pane] + delta) }));
   }
   ```

### Step 2: Widen & Center the Divider Hit Area
1. Update `Divider` hit zone from `left-0 -right-1.5` to a centered 13px target:
   ```tsx
   <div className="absolute inset-y-0 -left-1.5 -right-1.5" />
   ```
   This gives 6px tolerance to the left of the line and 6px tolerance to the right, allowing effortless cursor grabbing from both directions.
2. Ensure the visual hover indicator remains centered:
   ```tsx
   <div className="absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 opacity-0 group-hover:bg-accent/60 group-hover:opacity-100 group-focus-visible:bg-accent group-focus-visible:opacity-100" />
   ```

### Step 3: Global Drag State Protection (Prevent Selection & Cursor Flicker)
1. In `Layout.tsx`, when `resizing` is active, apply a global style or class to `document.body`:
   - `cursor: col-resize !important`
   - `user-select: none !important`
2. In `Divider`, maintain `setPointerCapture` and ensure `pointerup` cleanly releases capture:
   ```tsx
   function down(event: PointerEvent<HTMLDivElement>) {
     event.currentTarget.setPointerCapture(event.pointerId);
     startX.current = event.clientX;
     onStart();
     onResizingChange(true);
   }

   function up(event: PointerEvent<HTMLDivElement>) {
     if (event.currentTarget.hasPointerCapture(event.pointerId)) {
       event.currentTarget.releasePointerCapture(event.pointerId);
     }
     onResizingChange(false);
   }
   ```
   Attach `onPointerUp={up}` in addition to `onLostPointerCapture={() => onResizingChange(false)}`.

---

## 3. Verification Plan

1. **Automated Playwright Verification**:
   - Test starting at 1280px viewport:
     - Drag divider left 100px $\rightarrow$ width increases from 400px to 500px.
     - Drag divider right 80px $\rightarrow$ width decreases from 400px to 320px.
   - Test at 1024px viewport:
     - Verify divider is NOT frozen and can be dragged in both directions within valid clamps.
   - Test hit target:
     - Hovering at `divider.x - 4px` triggers `cursor: col-resize`.
     - Hovering at `divider.x + 4px` triggers `cursor: col-resize`.
2. **Build Verification**:
   - Run `npm run build` in `desktop/` to verify zero TypeScript or bundle regressions.
3. **Manual Interactive Verification**:
   - Drag chat pane wider and narrower smoothly using mouse.
   - Verify note editor text is not selected during drag.
   - Verify chat content layout remains clean and readable at 320px.
