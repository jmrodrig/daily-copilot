# Implementation Plan: Keyboard Shortcut for Editing

## Goal
Create a keyboard shortcut (the "e" key) to instantly transition a published page into edit mode.

## Branch
Use branch `feat/edit-shortcut`

## 1. Add Keyboard Shortcut
**File:** `desktop/src/pages/NotePage.tsx`
- Add a new `useEffect` that listens for the `keydown` event on `window`.
- The shortcut should only work when the note is in read-only/published mode (`state === "published"`).
- In the handler:
  - Check if `event.key === "e"` and no modifiers (ctrl, meta, alt) are pressed.
  - Check that the user is not typing in an input field (ensure `event.target` is not an `HTMLInputElement`, `HTMLTextAreaElement`, or an element with `isContentEditable`).
  - If conditions are met, call `event.preventDefault()` and trigger the edit mode by calling `save("draft")`.
- **Note:** Since `save` is a local function that changes on every render, you may want to store it in a `useRef` (e.g. `const saveRef = useRef(save); saveRef.current = save;`) and use `saveRef.current("draft")` inside the `useEffect`, to prevent the `keydown` listener from constantly detaching and re-attaching on every keystroke.
