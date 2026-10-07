# Implementation Plan: Task Management Improvements

## Overview
This feature branch (`feat/task-mgmt-improvements`) introduces several Jira-style task management improvements, including status change comments, a new "Archived" status, configurable status flows, custom task fields, a new Task List view with bulk edit capabilities, and a "People" directory.

## Branching
- Implement this feature on a new isolated feature branch: `feat/task-mgmt-improvements`

## 1. Feature: Archived Status
### Backend (`backend/schemas.py`, `backend/models.py`)
- Add `ARCHIVED = "archived"` to the `Status` enum in `schemas.py`.
- Update relevant queries to exclude archived tasks by default unless explicitly requested.

### Frontend
- Add "Archived" to all task status dropdowns.
- Hide archived tasks from the standard Kanban and Backlog views, unless a filter specifically requests them.

## 2. Feature: Task Status Flow (Jira-style) & Space Preferences
### Backend
- Update the `Space` model (in `models.py`) and schema (`schemas.py`) to include a `status_flow` JSON field.
  - Structure: A dictionary mapping a `Status` (string) to a list of allowed next `Status` (strings). If null or empty, all transitions are allowed (default).

### Frontend
- Update `SpacePreferences.tsx` to include a UI for defining the `status_flow`.
- In `TaskPanel.tsx` (or any task status selector), compute the allowed next statuses based on the space's `status_flow` and the task's current status.

## 3. Feature: Custom Task Fields
### Backend
- Update the `Space` model and schema to include `custom_fields_schema` (JSON list of dicts defining field id, name, and type).
- Update the `Task` model and schema to include `custom_fields` (JSON dictionary mapping field ID to value).
- Ensure `TaskUpdate` schema accepts `custom_fields`.

### Frontend
- Update `SpacePreferences.tsx` to allow adding custom fields to the space's schema.
- Update `TaskPanel.tsx` to dynamically render inputs for each custom field defined in the space's schema and save them to the task.

## 4. Feature: Status Change Comment Pop-up
### Frontend
- In `TaskPanel.tsx` (and other status toggle components), intercept the status change event.
- If the status changes (e.g., Blocked -> In Progress, In Progress -> Done), present a Modal/Dialog asking for an optional comment.
- If a comment is provided, make an API call to `POST /api/tasks/{id}/comments` alongside the `PATCH` task status update.
- If skipped, just update the status.

## 5. Feature: Simple List View with Bulk Edit
### Backend
- Add a new endpoint `POST /api/tasks/bulk-update` taking a schema like `{ task_ids: list[int], updates: TaskUpdate }`.

### Frontend
- Create a new list view component (e.g., `desktop/src/pages/TaskListView.tsx`).
- Implement a table showing tasks with a left-side checkbox for multi-selection.
- Implement a filter input to search/filter tasks.
- Add a bulk action toolbar that appears when tasks are selected (e.g., Change Status, Assign To, Archive).
- Call the new bulk update endpoint and refresh the list upon completion.
- Integrate this list view into the existing "Tasks" routing or sidebar (maybe a toggle next to Kanban/Gantt).

## 6. Feature: "People" Concept
### Backend
- Create a new `Person` model in `backend/models.py`:
  - Fields: `id`, `space_id`, `name`, `email` (optional), `company` (optional), `is_external` (boolean), `avatar_url` (optional).
- Create corresponding Pydantic schemas in `backend/schemas.py`.
- Add CRUD endpoints in `backend/main.py` (`/api/people`).

### Frontend
- Replace the existing `Placeholder.tsx` logic for the `/people` route with a real `People.tsx` component.
- Build a list/grid view of contacts showing their name, email, company, and a badge for Internal/External.
- Render an avatar, defaulting to the person's initials if `avatar_url` is absent.
- Provide a simple form to add a new person.

## Manual User-Driven Testing Gate
After the implementer agent completes the code:
1. Verify the frontend and backend compile correctly (no TS errors or failing tests).
2. Ask the user to visit Space Preferences and define a Status Flow and a Custom Field.
3. Ask the user to visit a Task, change its status to trigger the comment popup, and fill out a custom field.
4. Ask the user to visit the new Task List View and bulk-edit multiple tasks to "Archived".
5. Ask the user to visit the People page and create a new internal and external contact.
