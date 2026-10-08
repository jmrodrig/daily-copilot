# Implementation Plan: Bulk Edit Dialog (v5)

## Overview
The current bulk action toolbar only allows changing Status and Assignee inline. The user requested the ability to edit *any* field via a bulk edit popup dialog. We will replace the inline dropdowns with a button that opens a comprehensive `BulkEditDialog`.

## Branching
- Continue on `feat/task-mgmt-improvements`.
- Update any impacted frontend tests.

## 1. Backend
- No changes required. The `POST /api/tasks/bulk-update` endpoint and `_apply_task_update` already support full `TaskPatch` application, including custom fields merging and null-clearing.

## 2. Frontend - New Component (`desktop/src/components/BulkEditDialog.tsx`)
- Create a modal dialog component (following the visual pattern of `StatusChangeDialog` or a standard fixed-overlay).
- Props should include the selected `tasks`, `flow` (for allowed statuses), `people`, `customFields`, `onApply` and `onClose`.
- **State Management:**
  - Need a way to track which fields the user *intends* to update (e.g. `enabledFields: Set<string>`). Unchecked fields are ignored.
  - Track the Draft updates (`updates: TaskPatch`).
- **UI Layout:**
  - **Header:** "Bulk Edit {tasks.length} Tasks".
  - **Body (Scrollable):** A list of rows for each editable field.
    - Each row starts with a Checkbox enabling/disabling that specific field.
    - If checked, show the corresponding input:
      - **Status:** Select dropdown (intersect `allowedStatuses` for all selected tasks).
      - **Assignee:** `AssigneeSelect` component.
      - **Priority:** Select dropdown (Low, Normal, High, Urgent).
      - **Start Date / Due Date:** Date input, plus a way to select "Clear date".
      - **Is Gantt Task / Is Milestone:** Select dropdown (Yes, No).
      - **Custom Fields:** Render input matching the `field.type` (Text, Number, Date, Checkbox, Dropdown).
  - **Footer:** "Cancel" and "Apply Changes" buttons.
- **Submit Logic:** Construct a `TaskPatch` from only the enabled fields and pass it to `onApply(patch, "Bulk edit")`.

## 3. Frontend - Integration (`desktop/src/pages/TaskListView.tsx`)
- Refactor the `BulkToolbar` component:
  - Keep the `{tasks.length} selected` counter.
  - Remove the inline Status and Assignee dropdowns.
  - Add a primary "Bulk Edit..." button that sets state to open the `BulkEditDialog`.
  - Maintain the existing bulk "Archive" quick-action button if all selected tasks are allowed to transition to `archived`.
- Render the `BulkEditDialog` when the state is open.
