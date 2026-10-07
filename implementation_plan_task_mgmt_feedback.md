# Implementation Plan: Task Management Feedback

## Overview
This plan addresses user feedback on the newly implemented task management features. We will expand custom fields to support dropdowns, add a comment flag to the status flow matrix, link task assignees directly to the new "People" list, and add a way to identify the primary user.

## Branching
- Continue working on the same branch: `feat/task-mgmt-improvements`
- Ensure tests still pass after these modifications.

## a) Custom Fields: Dropdown Option
### Backend
- Update the custom field schema definition in `backend/schemas.py` and `backend/models.py` (if necessary) to allow `type: "dropdown"`.
- Add an `options: list[str]` property to the custom field definition schema.

### Frontend
- Update `desktop/src/pages/SpacePreferences.tsx`. When a user selects "Dropdown" for a custom field type, show a text input for them to define the options (e.g., comma-separated values).
- Update `desktop/src/components/TaskPanel.tsx` and the List View. For custom fields of type "Dropdown", render a standard HTML `<select>` element populated with the defined options.

## b) Matrix: Comment Request Flag
### Backend
- Update the `status_flow` schema on the `Space` model.
- Instead of just a list of allowed next statuses (e.g., `dict[Status, list[Status]]`), it must store whether a comment is requested for that transition.
- Structure suggestion: `dict[Status, dict[Status, bool]]`, where the boolean represents `requires_comment` (or `requests_comment`).

### Frontend
- Update `desktop/src/pages/SpacePreferences.tsx`. In the status matrix grid, allow the user to toggle not just if a transition is allowed (checkbox), but also if it requests a comment (e.g., a secondary small icon/toggle in the cell, or cycling through 3 states: Blocked -> Allowed -> Allowed+Comment).
- Update the status change logic (Kanban, Backlog, TaskPanel). Only trigger the `StatusChangeDialog` comment pop-up if the transition's comment flag is set to true in the `status_flow`.

## c) Task Assignment from People List
### Frontend
- Fetch the list of people from `/api/people` in the task-related contexts.
- In `desktop/src/components/TaskPanel.tsx` and the new List view bulk-edit toolbar, replace the free-text assignee input with a dropdown/select populated by the `People` list.
- Task assignees should still visually show the person's name or initials.

## d) Identify "Me" (Current User)
### Backend
- Update the `Person` model in `backend/models.py` to include `is_me: Mapped[bool] = mapped_column(default=False)`.
- Update the `/api/people` endpoints and schemas to support setting `is_me`. Ensure only one person per space (or globally) can be marked as `is_me = True`. If a new person is set to `is_me = True`, unset it for others in the space.

### Frontend
- Update `desktop/src/pages/People.tsx`. Add a visual indicator (like a star or a "This is me" button) to mark a person as the current user.
- Highlight the "Me" person visually in the assignee dropdowns (e.g., "Jose Rodrigues (Me)").
