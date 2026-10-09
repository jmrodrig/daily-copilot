# Implementation Plan: Copilot Chat Action Buttons (Copy, Stop/Interrupt, Edit)

## Objective
Add three interactive capabilities to the Co-pilot chat (`desktop/src/components/CopilotChat.tsx`):
1. **Copy Response Button:** Copy assistant responses to the clipboard with visual confirmation.
2. **Stop / Interrupt Button:** Cancel/abort an in-flight query while the model is thinking.
3. **Edit Prompt Button:** Allow users to edit past prompts by populating the chat textarea and focusing it.

---

## Detailed Requirements

### 1. Copy Response Button (Assistant turns)
- **Target:** Inside assistant message entries (`entry.role === "assistant"`).
- **Position:** Action bar at the bottom or corner of the assistant message card.
- **Visuals:**
  - Default: Copy icon (SVG) with label "Copy" (or icon with title/aria-label "Copy response").
  - On click: Calls `navigator.clipboard.writeText(entry.content)` and switches to a checkmark icon with label "Copied" for 2 seconds.
  - Track state per-entry or using a `copiedIndex: number | null` state.
  - Safe error handling: catch clipboard rejection gracefully.

### 2. Stop / Interrupt Button (`sending === true`)
- **Target:** Both in the input toolbar (replacing or next to the Send button) and near the "Thinking…" indicator in the chat list.
- **Mechanism:**
  - Create `abortControllerRef = useRef<AbortController | null>(null)`.
  - In `send()`, instantiate a new `AbortController()`, assign to `abortControllerRef.current`, and pass its `signal` to `fetch("/api/chat", { ..., signal: controller.signal })`.
  - Provide a `stop()` handler:
    ```typescript
    function stop() {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
        abortControllerRef.current = null;
      }
    }
    ```
  - In `catch (err)`:
    - If `(err as { name?: string })?.name === "AbortError"`, treat this as an intentional cancellation:
      - Do NOT show an error message ("Could not get an answer (AbortError)").
      - Keep the user entry in the chat history so they can edit it or leave it as reference.
      - Clear `error`.
    - If any other error, retain existing error behavior.
  - In `finally`:
    - Ensure `setSending(false)` and `abortControllerRef.current = null`.
  - If `spaceId` changes or the component unmounts, abort any pending request:
    ```typescript
    useEffect(() => {
      return () => {
        abortControllerRef.current?.abort();
      };
    }, []);
    ```
- **UI:**
  - In the input bar: When `sending` is true, show a "Stop" button with a stop/square icon (styled with subtle accent border/background like `btn border-accent/40 bg-accent/10 text-accent hover:bg-accent/20 min-h-11`) instead of the Send button.
  - In the chat scroll area: Beside `{sending && <p ...>Thinking…</p>}`, show a companion `<button onClick={stop} ...>Stop</button>` so the user can easily interrupt from either place.

### 3. Edit Prompt Button (User turns)
- **Target:** Inside user message bubbles (`entry.role === "user"`).
- **Position:** Subtle action button inside or at the bottom-right corner of the user message bubble.
- **Visuals:** Pencil/Edit icon (SVG) with text "Edit" or tooltip `title="Edit prompt"`, visible on hover or subtly styled (`text-xs text-text-muted hover:text-text-primary`).
- **Behavior:**
  - Extracts prompt text:
    - If `entry.prompt` exists: `${entry.prompt.command}${entry.prompt.rest ? ` ${entry.prompt.rest}` : ""}`.
    - Else: `entry.content`.
  - Sets `setInput(text)`.
  - Sets `setMenuDismissed(true)`.
  - Focuses `inputRef.current` and positions the cursor at the end:
    ```typescript
    setTimeout(() => {
      if (inputRef.current) {
        inputRef.current.focus();
        inputRef.current.setSelectionRange(text.length, text.length);
      }
    }, 0);
    ```

### 4. Supporting SVG Icons
Add helper icon components to `CopilotChat.tsx`:
- `CopyIcon` (clipboard icon)
- `CheckIcon` (checkmark icon)
- `StopIcon` (stop / square icon)
- `PencilIcon` (pencil icon)

---

## Verification Steps
1. Run `npm run typecheck` in the `desktop/` directory to ensure complete TypeScript compliance.
2. Run `pytest backend/tests/` to ensure backend test suite remains green.
3. Verify that the UI styling adheres to existing Tailwind tokens (`text-text-muted`, `text-text-primary`, `bg-surface-raised`, `bg-surface-active`, `btn`, `btn-primary`, etc.).
