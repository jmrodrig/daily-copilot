# Implementation Plan: Phase 13 - Listening Indicator Position and White Color Scheme

## Task ID: phase-13-listening-indicator-position-and-color
## Branch: phase-13-listening-indicator-position-and-color

---

## 1. Problem Statement & Motivation
- **Obstructive Placement**: Currently, `ListeningIndicator` in `desktop/src/components/Layout.tsx` is fixed at `left-1/2 top-2 -translate-x-1/2`. When listening is active, the pill floats directly over the center-top of the main editor, blocking note action buttons (`Publish`, `History`, `New window`) and the note title.
- **Color Scheme**: The indicator uses red styling (`🔴` circle, `border-red-500/60`, and red `Stop` button). The window/tab title also uses `🔴 Listening (00:XX)`.
- **User Request**:
  1. Move the listening indicator to the top-right header area (as highlighted in the user screenshot, clear of editor buttons).
  2. Change its color scheme from red to white (white indicator dot, white text/border, white Stop button).
  3. Change the page title (`document.title`) indicator from red to white (`⚪ Listening (${clock})`).

---

## 2. Architecture & Component Changes

### A. Window/Tab Title (`desktop/src/context/VoiceRecordingContext.tsx` & `desktop/src/lib/title.ts`)
1. In `desktop/src/context/VoiceRecordingContext.tsx`:
   - In `setTitleStatus`:
     - Change `🔴 Listening (${clock})` to `⚪ Listening (${clock})`.
     - Update comment from `"🔴 Listening (01:23)"` to `"⚪ Listening (01:23)"`.
2. In `desktop/src/lib/title.ts`:
   - Update comment from `"🔴 Listening (01:23)"` to `"⚪ Listening (01:23)"`.

### B. Listening Indicator Component (`desktop/src/components/Layout.tsx`)
1. **White Color Scheme**:
   - Replace `🔴` with `⚪` (white circle) or a crisp white indicator dot.
   - Replace `border-red-500/60` with a clean white/subtle border: `border-white/30 hover:border-white/50 bg-surface-raised text-text-primary`.
   - Update the Stop button from:
     `border-red-500/50 text-red-500 hover:bg-red-500/10`
     to:
     `border-white/30 text-white hover:bg-white/10 hover:border-white/60`.
2. **Top-Right Positioning**:
   - Remove `left-1/2 -translate-x-1/2`.
   - Position at `fixed top-2 z-40`:
     - Support positioning in the top-right header area:
       - When the chat pane is open (`chatOpen` is true), place it at `right-36` (to the left of the 4 chat action buttons `+`, `↺`, `📌`, `>` which occupy the rightmost 120px).
       - When chat is collapsed (`chatOpen` is false), place it at `right-14` (to the left of the collapsed rail expand button).
       - Ensure `ListeningIndicator` accepts or derives `chatOpen` from layout context/props so it adapts smoothly.
3. **PWA Window Controls Overlay Support (`desktop/vite.config.ts`)**:
   - In `desktop/vite.config.ts`, include `display_override: ["window-controls-overlay", "standalone"]` in the PWA manifest so Chromium desktop PWA can optionally integrate into the titlebar area cleanly.

---

## 3. Implementation Steps for Jibby (Claude Code)
1. **Title & Context**:
   - In `desktop/src/context/VoiceRecordingContext.tsx`, update `setTitleStatus` to use `⚪ Listening (${clock})`.
   - In `desktop/src/lib/title.ts`, update comments.
2. **Indicator Styling & Positioning**:
   - In `desktop/src/components/Layout.tsx`, update `ListeningIndicator`:
     - Update styling to white (white dot, white border, white Stop button).
     - Update positioning to the top-right area (`fixed top-2 z-40`, adjusting `right` so it never collides with chat buttons or rail).
3. **PWA Manifest (`desktop/vite.config.ts`)**:
   - Add `display_override: ["window-controls-overlay", "standalone"]`.
4. **Verification**:
   - Run `pytest backend/tests/test_voice.py` to ensure backend tests stay healthy.
   - Run `npm run build` in `desktop/` to verify TypeScript and Vite compilation.
   - Commit all changes to branch `phase-13-listening-indicator-position-and-color`.

---

## 4. User-Driven Manual Testing Plan
1. **Indicator Position Hands-On Test**:
   - Start dev servers (`start.cmd` or uvicorn & vite).
   - Open a note in the UI.
   - Click "Start Listening" in the listen widget.
   - **Verify**: The listening pill appears in the top-right header area.
   - **Verify**: It does NOT block `Publish`, `History`, `New window`, or the note title.
   - **Verify**: It does NOT obstruct the chat header buttons (`+`, `↺`, `📌`, `>`).
2. **Color Scheme Test**:
   - **Verify**: The listening pill displays a white dot (`⚪`), a white/neutral border, and a white `Stop` button (no red).
   - **Verify**: The browser window/tab title displays `⚪ Listening (00:XX)` instead of `🔴`.
3. **Responsive / Collapse Test**:
   - Collapse the chat panel using the `>` button.
   - **Verify**: The listening pill remains visible and accessible in the top right.
   - Click the white "Stop" button.
   - **Verify**: Recording stops and transcribing begins smoothly.
