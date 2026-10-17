# Implementation Plan: Automatic Note Refreshing & Chat Reply Payout

**Target Components:**
1. `desktop/src/lib/notes.ts` (New module for note change notifications)
2. `desktop/src/pages/NotePage.tsx` (Automatic note reloading upon updates)
3. `desktop/src/components/CopilotChat.tsx` (Dispatching note updates, progressive reply payout, clear thinking/answering/finished indicators)

---

## 1. Problem Statement

1. **Manual Refresh Needed**: When the Co-pilot writes to a note (either directly via `write_note` tool in `write_directly` mode, or when the user approves a proposed edit in `ask_first` mode), the open note in `NotePage` does not update automatically. The user has to manually reload or refresh the page to see the changes.
2. **Abrupt Reply Delivery ("Thrown at User")**: With Gemini API (which returns answers in full batches rather than token-by-token CLI streaming), the chat UI shows "Thinking..." with a spinner for several seconds, and then suddenly throws the entire response onto the screen in zero milliseconds. The user has no indication that the thinking ended and the answering began, misses the transition, and cannot tell when the agent finished answering.

---

## 2. Proposed Solution

### Part A: Automatic Note Refreshing

1. **Create `desktop/src/lib/notes.ts`**:
   - Define custom event `NOTE_UPDATED_EVENT = "copilot:note-updated"`.
   - Setup a `BroadcastChannel("copilot:notes")` so updates work in the current window as well as any popout note windows (`openNoteInNewWindow`).
   - Export `notifyNoteUpdated(spaceId: number, path: string)`:
     Dispatches the event locally and broadcasts via `BroadcastChannel`.
   - Export `useNoteUpdates(spaceId: number, path: string, onUpdate: () => void)`:
     React hook subscribing to note updates for the specific space and path.

2. **Trigger Updates in `desktop/src/components/CopilotChat.tsx`**:
   - In `readResponse`:
     - When receiving `tool_end` where `name === "write_note"` and `ok === true`:
       Extract `path` from tool arguments and call `notifyNoteUpdated(spaceId, path)`.
     - When receiving `done`:
       For each path in `body.written_paths`, call `notifyNoteUpdated(spaceId, path)`.
   - In `approve()`:
     - After `fetch("/api/notes/apply-edit")` succeeds, call `notifyNoteUpdated(spaceId, edit.path)`.

3. **Handle Updates in `desktop/src/pages/NotePage.tsx`**:
   - Use `useNoteUpdates(spaceId, path, () => reload())`.
   - When notified:
     - If `!dirty` (user has no unsaved changes in progress):
       Re-fetch `/api/notes/file`, update `note`, `body`, and `titleDraft`.
       Re-fetch tasks via `/api/tasks`.
       Call `refreshTree()` in case note title or tags changed.
     - If `dirty` (user is currently typing unsaved edits):
       Display a non-intrusive warning banner: *"Co-pilot updated this note on disk. [Reload to view changes]"*.

---

### Part B: Progressive Reply Payout & Clear Phase Indicators

1. **Clear Phase Indicators in `LiveActivityCard`**:
   - **Thinking / Tools Phase**:
     - Status: `<SpinnerIcon className="animate-spin text-accent" /> <span className="font-medium text-text-primary">Thinking…</span>` (or `Searching notes: <query>…` / `Reading note: <path>…`).
     - Distinct badge: `Thinking` or `Researching`.
   - **Answering / Paying Out Phase**:
     - Status: `<PencilIcon className="h-3.5 w-3.5 text-accent animate-pulse" /> <span className="font-semibold text-text-primary">Answering…</span>`
     - Distinct badge: `Writing response`.
     - Live preview displays the text progressively paying out, ending with an animated blinking/pulsing cursor `●`.
   - **Finished Phase**:
     - When payout completes:
       Shows `<CheckIcon className="h-3.5 w-3.5 text-project-p5002" /> <span className="font-medium text-project-p5002">Finished answering</span>` for 400ms before finalizing into the permanent chat thread.

2. **Progressive Reply Payout Mechanism in `CopilotChat.tsx`**:
   - If the response arrives in bulk without live `text_delta` tokens (typical for Gemini API via LiteLLM):
     Instead of abruptly removing the card and dumping the whole text, `payoutReply(body.reply)` progressively yields words or token chunks into `streamingText` at a smooth reading cadence (~20–25ms per chunk).
   - Allows instant completion if the user presses "Stop" or enters a new message.
   - Smoothly scrolls chat to keep the paying-out text in view.

3. **Permanent Finished Indicator**:
   - In the completed assistant message card in the chat transcript:
     Add a clear header or footer indicator:
     `<span className="text-[11px] text-text-muted">Finished answering</span>` alongside the timestamp and copy button.

---

## 3. Implementation Steps

1. Create `desktop/src/lib/notes.ts` with `notifyNoteUpdated` and `useNoteUpdates`.
2. Update `desktop/src/pages/NotePage.tsx` to subscribe to note updates and reload automatically when `!dirty`.
3. Update `desktop/src/components/CopilotChat.tsx`:
   - Connect note writing (`tool_end`, `done`, `approve`) to `notifyNoteUpdated`.
   - Add progressive payout typewriter logic for completed replies that did not have live streaming deltas.
   - Update `LiveActivityCard` with distinct visual states for Thinking vs Answering vs Finished.
   - Add completion indicator to assistant messages.
4. Run `npm run build` in `desktop/` to verify zero TypeScript errors.
5. Verify with automated Playwright script:
   - Note page automatically updates when Co-pilot writes a note.
   - Reply pays out progressively with clear "Answering..." and "Finished" indicators.
