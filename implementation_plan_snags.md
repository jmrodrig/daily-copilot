# Implementation Plan: Minor Improvements & Snag Resolution

## Overview
This plan resolves four specific UX/UI issues to improve application polish and consistency, ranging from styling fixes to feature parity across editors.

## Branch
Use branch `feat/minor-improvements`

## 1. Sidebar Project Colors
**File:** `desktop/src/components/Sidebar.tsx`
- **Issue:** Projects currently hardcode the `text-project-c7801` CSS class.
- **Fix:** Extract the `projects` from the active space via `useSpace()`. When rendering a `folder` that `is_project`, look up the project by `folder.project_id`. If it has a color, apply it inline: `style={{ color: project.color }}` to both the text span and the `FolderIcon`. Remove the hardcoded Tailwind color class.

## 2. Markdown Task Descriptions
**Files:** `desktop/src/components/TaskPanel.tsx`, `desktop/src/components/NoteEditor.tsx`
- **Issue:** Task descriptions use a basic textarea and don't render markdown like notes do.
- **Fix:** 
  1. Update `NoteEditor` to make `title` and `onTitleChange` optional. If omitted, do not render the `TitleInput`.
  2. Add an optional `compact` boolean prop to `NoteEditor`. If true, reduce the generous horizontal padding applied via `NOTE_COLUMN` so it fits nicely inside the narrow `TaskPanel`.
  3. In `TaskPanel.tsx`, update `DescriptionField` to use `<NoteEditor>` instead of `<textarea>`. Feed it the `task.space_id`, `draft`, `setDraft`, and `commit` functions, with `compact={true}`.

## 3. Text Format in Edit Toolbar
**File:** `desktop/src/components/NoteEditor.tsx` (the `Toolbar` component)
- **Issue:** There's no way to create headings using the formatting toolbar.
- **Fix:** Add a `<select>` dropdown (or a custom menu) to the `Toolbar` with options: "Normal text", "Heading 1", "Heading 2", and "Heading 3".
  - Read the active heading level in `useEditorState` using `e.isActive('heading', { level: X })`.
  - Wire the onChange handler to use `editor.chain().focus().setParagraph().run()` for Normal text, and `editor.chain().focus().toggleHeading({ level: X }).run()` for headings.

## 4. Minimum Panel Widths
**File:** `desktop/src/components/Layout.tsx`
- **Issue:** Panels break their internal layouts when resized too narrowly or when the browser window shrinks.
- **Fix:** 
  1. Increase the minimum sizes in the `PANES` constant to prevent dragging them too small (e.g., `left.min`: 240, `task.min`: 360, `chat.min`: 320, `MAIN_MIN`: 400).
  2. Modify `paneStyle` to guarantee that panels never compress horizontally beyond their current dragged size when the main window shrinks. Returning `minWidth: widths[pane]` rather than `minWidth: PANES[pane].min` ensures they hold their shape, allowing the parent flex container's `overflow-hidden` to correctly clip instead of crushing the layout.
