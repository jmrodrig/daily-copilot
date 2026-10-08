# Implementation Plan: UI & Content Fixes

## Goal
Resolve multiple UX/UI and formatting issues across the layout, note creation, image handling, task pills, and the content tree.

## Branch
Use branch `feat/ui-fixes`

## 1. AI Agent Minimum Width (Goal A)
**File:** `desktop/src/components/Layout.tsx`
- **Issue:** The AI agent bot (Copilot chat panel) is too narrow at its default minimum width.
- **Fix:** Update the `PANES` constant for the `chat` pane to have a `min: 400` (up from 320), ensuring it matches the task panel minimum width and gives the AI more room.

## 2. Prevent Duplicate Note Headings (Goal B)
**File:** `backend/main.py`
- **Issue:** `create_note` always inserts `# {title}\n` into the note body.
- **Fix:** In `create_note`, remove the default heading insertion. The initial `content` should just be `""` (empty string) unless a template explicitly provides content.

## 3. Image Captions (Goal C)
**File:** `desktop/src/components/NoteEditor.tsx`
- **Issue:** Images do not display captions or subtitles.
- **Fix:** In the `ImageView` component (the custom ReactNodeViewRenderer for images), add caption rendering below the image. 
  - Use the image node's `title` attribute for the caption text (since `![alt](src "title")` is standard markdown).
  - Add an `<input>` or editable element directly below the `<img />` in the DOM tree, styled like a subtle `<figcaption>` (e.g. smaller text, muted color, centered).
  - Use `value={title ?? ""}` and `onChange={(e) => updateAttributes({ title: e.target.value })}`.
  - Only show this caption input if the image is `selected` OR if a `title` already exists and is non-empty.

## 4. Explicit Status on Task Pills (Goal D)
**Files:** `desktop/src/components/referencePill.tsx` and `desktop/src/pages/NotePage.tsx`
- **Issue:** The colored dot on task pills isn't visible enough, and the user wants an explicit label like `[DONE]`.
- **Fix:** In `PillView` and `TaskPillLink`:
  - Change the rendering of the status indicator. Instead of just a colored dot, render the status as uppercase text enclosed in brackets (e.g., `[TODO]`, `[IN_PROGRESS]`). Use the `STATUS_LABELS` if helpful, or just uppercase the raw status string.
  - Apply the `statusColor` to this text (using `color:` or a badge-like background with low opacity). Make it bold and clear so it stands out immediately before the task name.
  - (Wait, you can import `STATUS_LABELS` from `../lib/tasks`).

## 5. Unbold the Content Tree (Goal E)
**File:** `desktop/src/components/Sidebar.tsx`
- **Issue:** Items in the left content tree are bolded (using `font-semibold` or `font-medium`), which the user dislikes.
- **Fix:** In `FolderTree` and related tree rendering components, strip out `font-semibold` and `font-medium` from the node text classes and replace them with `font-normal`. Project folders and root folders should all render as unbolded text.
