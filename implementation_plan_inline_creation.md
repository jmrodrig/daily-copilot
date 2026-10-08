# Implementation Plan: Enhanced Inline Task Creation

## Goal
Improve the inline task creation experience (Kanban Add Card and New Task Row) with better project visuals, a combobox for assignees, and configurable custom fields.

## Branch
Use branch `feat/inline-task-enhancements`

## 1. Custom Fields Configuration
**Files:** `backend/schemas.py`, `desktop/src/lib/space.ts` (or `.tsx`), `desktop/src/pages/SpacePreferences.tsx`
- **Backend Schema:** In `CustomFieldDef`, add `show_inline: bool = Field(default=False, description="Show this field in the inline task creation card")`.
- **Frontend Type:** Add `show_inline?: boolean` to the `CustomFieldDef` TS interface.
- **Space Preferences:** In `SpacePreferences.tsx`, update the Custom Fields editor table/form to include a "Show in inline creation" checkbox for each field.

## 2. Assignee Combobox (Goal B)
**File:** `desktop/src/lib/people.tsx`
- **Issue:** `AssigneeSelect` is a native `<select>`, preventing users from typing new names.
- **Fix:** Refactor `AssigneeSelect` to be a custom combobox (text `<input>` + dropdown list).
- Allow users to search/filter the `people` list.
- If the typed name doesn't exist, show an option to "Create '<name>'" or simply let them blur/press enter to accept the new string. The `value` emitted by `onChange` should be the raw string name, whether it exists in `people` or not.

## 3. Inline Task Creation Form Enhancements (Goals A & C)
**File:** `desktop/src/pages/Tasks.tsx` (specifically `KanbanAddCard`)
- **Fix A (Project Visuals):** Transform `KanbanAddCard` from a single text input into a mini-card layout (matching `KanbanCard`'s style). Under the title input, show the selected project as a coloured pill (using the same styling/components as `ProjectTag`). Allow the user to click the pill to open a dropdown/menu to change the project. Avoid repeating the word "Project" redundantly.
- **Fix B (Assignee):** Embed the newly upgraded `AssigneeSelect` combobox in this mini-card so the user can assign the task before hitting enter.
- **Fix C (Custom Fields):** Inside `KanbanAddCard`, loop through `customFields.filter(f => f.show_inline)`. For each, render a small inline input or dropdown (depending on its type) to allow setting those fields immediately upon creation. Ensure these fields are included in the `TaskCreate` payload.
- Note: Apply similar Project Pill and Custom Field logic to `TaskTable.tsx` (`NewTaskRow`) if necessary, ensuring visual consistency across all inline creation spots.
