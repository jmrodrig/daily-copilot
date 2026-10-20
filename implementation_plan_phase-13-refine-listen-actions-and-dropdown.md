# Implementation Plan: Phase 13 - Refine Listen Actions and Dropdown Layout

## Task ID: phase-13-refine-listen-actions-and-dropdown
## Branch: phase-13-refine-listen-actions-and-dropdown

---

## 1. Problem Statement & Motivation
Based on user screenshot annotations:
1. **Co-pilot Quick Action Buttons (Screenshot 1)**:
   - In `desktop/src/components/ListenWidget.tsx`, the completed meeting block displays three Co-pilot action buttons under `Ask the Co-pilot:`:
     - `Summarize Meeting`
     - `Extract Action Items`
     - `Extract Decisions`
   - Currently, they are styled as chunky `.btn` elements (`min-h-8 px-2.5 text-[14px]` with solid borders and high-contrast text).
   - Requirement: **"make these more subtle and small (screenshot 1)"**.
   - Redesign them as subtle, compact suggestion chips (`text-xs`, lighter borders, muted secondary text, gentle hover states).
2. **Audio Source Dropdown & Start Listening Button Layout (Screenshot 2)**:
   - In `desktop/src/components/ListenWidget.tsx`, the pre-recording source selector and start button currently sit in a loose wrap row with `w-auto` on the select:
     - The "Start Listening" button sits immediately next to the select, leaving awkward empty space on the right of the card.
     - The select element uses the default browser chevron arrow which appears misaligned/awkward.
   - Requirement: **"fix the dropdown arrow and justify the button to the right, extenting the dropdown with the button (screenshot 2)"**.
   - Make the container full-width (`w-full`).
   - Extend the dropdown selector (`flex-1 min-w-0 w-full`) to take up all remaining width.
   - Justify the "Start Listening" button to the far right edge of the card (`shrink-0`).
   - Fix the dropdown arrow by using `appearance-none` with an elegant, centered SVG chevron positioned cleanly on the right side of the select input.

---

## 2. Architecture & Component Changes

### `desktop/src/components/ListenWidget.tsx`
1. **Subtle & Small Co-pilot Actions (`Completed` component)**:
   - In `Completed` (lines ~530-538):
     - Replace:
       ```tsx
       <button key={action.label} type="button" className="btn min-h-8 px-2.5 text-[14px]" onClick={() => promptCopilot(action.prompt(where))}>
         {action.label}
       </button>
       ```
     - With:
       ```tsx
       <button
         key={action.label}
         type="button"
         className="rounded-md border border-border-default/80 bg-surface-base/40 px-2 py-1 text-xs text-text-secondary hover:border-border-strong hover:bg-surface-hover hover:text-text-primary transition-colors"
         onClick={() => promptCopilot(action.prompt(where))}
       >
         {action.label}
       </button>
       ```
2. **Dropdown and Right-Justified Start Button**:
   - In pre-recording view (lines ~308-330):
     - Restructure layout to span full width with right justification:
       ```tsx
       <div className="flex flex-col gap-2">
         <div className="flex items-center gap-3 w-full">
           <label className="relative flex-1 min-w-0">
             <span className="sr-only">Audio source</span>
             <select
               aria-label="Audio source"
               value={picked.key}
               disabled={!interactive || pending || Boolean(lockedBy)}
               onChange={(e) => setChoice(e.target.value)}
               className="field w-full appearance-none pr-9 py-2 text-sm"
             >
               {options.map((o) => (
                 <option key={o.key} value={o.key}>
                   {o.label}
                 </option>
               ))}
             </select>
             <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center pr-3 text-text-muted">
               <svg aria-hidden width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                 <path d="M4 6l4 4 4-4" />
               </svg>
             </div>
           </label>
           <button
             type="button"
             className="btn-primary gap-2 shrink-0"
             disabled={!interactive || !note || pending || Boolean(lockedBy)}
             onClick={() => void start()}
           >
             <MicIcon />
             Start Listening
           </button>
         </div>
         {!note && interactive && <span className="text-xs text-text-muted">Open the note itself to record here.</span>}
         {note && interactive && clientAudioUnavailable() && (
           <span className="text-xs text-text-muted">{clientAudioUnavailable()}</span>
         )}
       </div>
       ```

---

## 3. Implementation Steps for Jibby (Claude Code)
1. **Update `desktop/src/components/ListenWidget.tsx`**:
   - Update `Completed` component's `AI_ACTIONS` buttons to be subtle, small, and refined.
   - Update pre-recording audio source selector to full-width flex layout with custom centered SVG chevron arrow, and right-justify `Start Listening`.
2. **Verification**:
   - Run `npm run build` in `desktop/`.
   - Run `pytest backend/tests/test_voice.py`.
   - Commit all changes to branch `phase-13-refine-listen-actions-and-dropdown`.

---

## 4. User-Driven Manual Testing Plan
1. **Co-pilot Actions Appearance Test**:
   - Open a note with a completed recording (or record a short clip and stop).
   - Scroll to the bottom of the completed `MEETING RECORDING` widget.
   - **Verify**: The buttons `Summarize Meeting`, `Extract Action Items`, and `Extract Decisions` appear subtle, small (`text-xs`), and unobtrusive.
   - Click each button to verify it still sends the prompt to the Co-pilot.
2. **Audio Source Dropdown & Start Button Test**:
   - In a note with an unrecorded `LISTEN` widget (or add a new `/listen` widget).
   - **Verify**: The "Audio source" dropdown expands across the card.
   - **Verify**: The dropdown arrow is a clean, centered chevron (not the awkward browser default).
   - **Verify**: The "Start Listening" button is justified to the far right edge of the widget.
   - Click the dropdown to verify device options still switch cleanly.
   - Click "Start Listening" to verify recording starts normally.
