# Implementation Plan: Phase 13 - UI Streamlining & Collapsible Listen Widget

## Task ID: phase-13-ui-streamlining-and-listen-collapse
## Branch: phase-13-ui-streamlining-and-listen-collapse

---

## 1. Problem Statement & Motivation
Based on user screenshot annotations (`media_1792360940944_4b524340.png`):
1. **Remove Floating Pill in Top-Right**: The floating badge `⚪ Listening (00:15) Stop` in the top right has been crossed out with a red X. It clutters the header and collides with panel buttons.
2. **Streamlined Listening Indicator with Quick Jump**: In the window title bar, the verbose text `Listening (00:15) ·` is crossed out. The user wants this replaced by a clean, subtle **blipping (pulsing) white circle** in the UI header next to the branding. When listening is active, clicking this blipping white circle immediately navigates to the recording note (`"CLICK TO GO TO NOTE"`).
3. **Collapsible Listen Widget**: In the note editor, the active `LISTEN` widget currently takes up significant vertical height with its bulky card controls. The user requested: `"ADD A BUTTON TO COLLAPSE INTO A SIMPLE [ ----- • ----- ] PAGE WIDTH SAME BLIPPING WHITE CIRCLE"`. When collapsed during recording, it minimizes into a page-width thin bar with the blipping white circle in the center. Clicking this bar expands it back to the full controls (`Pause`, `Stop`, timer, microphone).
4. **Sidebar Collapse Button on Left Margin**: In the sidebar header, the `<` collapse button currently sits on the right of `DAILY COPILOT` (crossed out with red X). The user wants the collapse toggle moved to the **far left edge** (`"COLLAPSE"`), aligning cleanly with the window margin.
5. **AI Assistant Button Replaces Chat Chevron**: In the chat header, the generic right chevron `>` (`IconButton direction="right"`) is crossed out with red X. The user specified: `"REPLACE W/ BUTTON FOR AI ASSISTANT"`. Replace the generic chevron with a dedicated AI Assistant icon button (e.g. Sparkles/Brain icon) that toggles the assistant pane open and closed.

---

## 2. Architecture & Component Changes

### A. Collapsible Listen Widget (`desktop/src/components/ListenWidget.tsx`)
1. **Collapsed State**:
   - Maintain `isCollapsed` state when recording is active.
   - In the `LISTEN` widget header or controls, provide a collapse toggle button (e.g. minimize/chevron icon).
2. **Collapsed Thin Bar View**:
   - When collapsed, render a minimal full-width bar spanning `PAGE WIDTH`:
     - Height: ~36px, clean subtle border (`border-border-default hover:border-white/40 bg-surface-raised/80`).
     - In the center: render the **blipping white circle** (a white dot with an outer ping/pulse animation ring).
     - Tooltip: `"Recording active (click to expand controls)"`.
     - Click handler: clicking anywhere on the bar expands it back to the full controls.
3. **White Color Scheme in Controls**:
   - Ensure the dot and voice activity bars inside the expanded `Listening` component use the clean white theme (`bg-white` and `bg-white/70 animate-voice-bar`).

### B. Global Listening Indicator & Title Status (`desktop/src/components/Layout.tsx`, `desktop/src/components/Sidebar.tsx`, `desktop/src/context/VoiceRecordingContext.tsx`)
1. **Remove Floating Pill**:
   - In `desktop/src/components/Layout.tsx`, remove the floating `ListeningIndicator` pill that was positioned at `right-36` / `right-14`.
2. **Header Blipping White Circle (Click to go to note)**:
   - In `desktop/src/components/Sidebar.tsx` (top of sidebar header next to title):
     - When `status.is_recording` is active:
       - Render a clickable blipping white circle:
         ```tsx
         <Link
           to={to}
           title={`Listening in ${noteTitle ?? "note"} (click to view)`}
           className="relative flex h-5 w-5 items-center justify-center rounded-full hover:bg-white/10"
         >
           <span className="absolute inline-flex h-3 w-3 animate-ping rounded-full bg-white opacity-60" />
           <span className="relative inline-flex h-2 w-2 rounded-full bg-white shadow-sm" />
         </Link>
         ```
       - When clicked, navigates directly to the note currently recording.
3. **Streamline Window Title (`desktop/src/context/VoiceRecordingContext.tsx`)**:
   - In `setTitleStatus`:
     - Instead of long text like `⚪ Listening (00:15)`, set title status to `⚪` when recording:
       `status.is_recording ? (status.is_paused ? "⏸" : "⚪") : status.is_processing ? "⏳" : ""`
     - Result in browser: `⚪ · ceasii - Daily Co-Pilot`, keeping the OS title bar clean and concise.

### C. Sidebar Header Layout (`desktop/src/components/Sidebar.tsx`)
1. Move `<IconButton>` from the right of `DAILY COPILOT` to the **far left**:
   ```tsx
   <div className="flex items-center justify-between pb-2.5 pl-3 pr-3 pt-3.5">
     <div className="flex min-w-0 items-center gap-2">
       <IconButton label="Collapse page tree" onClick={onCollapse} direction="left" />
       <span className="flex min-w-0 items-center gap-2.5">
         <img src="/logo/mark-adaptive.svg" width="24" height="24" alt="" className="shrink-0" />
         <span className="dc-wordmark truncate text-[15px]">Daily Copilot</span>
       </span>
     </div>
     {recordingActive && <ListeningBlippingDot />}
   </div>
   ```

### D. AI Assistant Button (`desktop/src/components/CopilotChat.tsx` & `desktop/src/components/Layout.tsx`)
1. **Chat Header Button (`desktop/src/components/CopilotChat.tsx`)**:
   - Replace `<IconButton label="Collapse chat" onClick={onCollapse} direction="right" />` with an AI Assistant button:
     - Render an AI Assistant icon (sparkles or brain icon) with label `"Close AI Assistant"`.
     - Clicking it collapses the chat pane.
2. **Collapsed Rail Button (`desktop/src/components/Layout.tsx`)**:
   - On the collapsed right rail (when `!chatOpen`), replace the generic `<IconButton label="Expand chat" direction="left" />` with the matching AI Assistant icon button:
     - Label: `"AI Assistant"`.
     - Tooltip: `"Open AI Assistant"`.
     - Clicking it expands the chat pane.

---

## 3. Implementation Steps for Jibby (Claude Code)
1. **ListenWidget Collapsible Bar**:
   - Add collapse/expand functionality to active `Listening` state in `desktop/src/components/ListenWidget.tsx`.
   - Render page-width slim bar with centered blipping white circle when collapsed.
   - Update active listening dot and voice bars to white.
2. **Remove Floating Pill & Add Header Blipping Circle**:
   - Remove floating pill from `desktop/src/components/Layout.tsx`.
   - Add the blipping white circle to `Sidebar.tsx` header with link to recording note.
   - Update `VoiceRecordingContext.tsx` title status to concise `⚪`.
3. **Sidebar Header Reordering**:
   - Move collapse button to the far left edge before the Daily Copilot logo/text.
4. **AI Assistant Buttons**:
   - Replace right chevron in `CopilotChat.tsx` with AI Assistant sparkle/brain icon button.
   - Replace left chevron on collapsed rail in `Layout.tsx` with AI Assistant sparkle/brain icon button.
5. **Verification**:
   - Run `npm run build` in `desktop/` to verify TypeScript and Vite compilation.
   - Run `pytest backend/tests/test_voice.py` and `pytest backend/tests/`.
   - Commit all changes to branch `phase-13-ui-streamlining-and-listen-collapse`.

---

## 4. User-Driven Manual Testing Plan
1. **Collapsible Listen Widget Test**:
   - Open a note and click "Start Listening".
   - Click the collapse button on the `LISTEN` widget.
   - **Verify**: The widget collapses into a thin, page-width bar with the blipping white circle in the center.
   - Click the thin bar.
   - **Verify**: It expands back into full controls (`Pause`, `Stop`, timer, mic selector).
2. **Header Blipping White Circle Test**:
   - While recording is active, navigate to another page (e.g. Dashboard or another note).
   - **Verify**: In the sidebar header, a blipping white circle is pulsing.
   - Click the blipping white circle.
   - **Verify**: You immediately jump back to the note that is actively recording.
   - **Verify**: The floating pill badge is gone from the top-right header.
   - **Verify**: The browser window title shows `⚪ · [Note Title] - Daily Co-Pilot`.
3. **Sidebar Left Collapse Button Test**:
   - **Verify**: In the sidebar header, the `<` collapse button is located on the far left edge before the logo.
   - Click it to collapse the sidebar, and click the rail button to expand it.
4. **AI Assistant Button Test**:
   - In the chat header, verify the collapse button is now an AI Assistant icon button.
   - Click it to collapse chat.
   - On the collapsed right rail, verify the expand button displays the AI Assistant icon.
   - Click it to expand chat.
