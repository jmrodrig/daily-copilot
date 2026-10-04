# Implementation Plan: Phase 9.1 - Flexible Task Views
**Task ID:** phase-9.1

## Goal
Replace the hardcoded task links in the sidebar (Kanban, Backlog, Gantt) with a dynamic "Saved Views" engine. Allow users to create multiple customized views (e.g., "C7801 Kanban", "My Overdue Backlog"), save their specific filters, and manage them from the sidebar.

## Scope
### 1. Database Schema (`backend/models.py`)
- Create a new `TaskView` table:
  - `id`: Integer primary key
  - `space_id`: Integer foreign key to `Space`
  - `name`: String (e.g., "Main Kanban")
  - `view_type`: String (`kanban`, `backlog`, `gantt`)
  - `filters`: JSON column storing current filter states (e.g., `{"project_id": null, "assignee": "Jose"}`).

### 2. Backend API (`backend/main.py`)
- Create CRUD endpoints for views:
  - `GET /api/views?space_id={id}`
  - `POST /api/views` (Creates a new view)
  - `PUT /api/views/{id}` (Updates name or filters)
  - `DELETE /api/views/{id}`

### 3. Frontend UI: Sidebar (`desktop/src/components/Sidebar.tsx`)
- **TASKS Header:** Add a `+` button next to the "TASKS" header. Clicking it opens a dropdown/menu to "New Kanban", "New Backlog", or "New Gantt".
- **Dynamic List:** Render the list of `TaskView` items returned from the API under the TASKS header.
- **Context Menu:** Add a `...` button (visible on hover) to each task view item in the sidebar with options:
  - Rename
  - Duplicate (Creates a new DB record with the same type and filters)
  - Delete

### 4. Frontend UI: Tasks Page (`desktop/src/pages/Tasks.tsx`)
- **Routing:** Update the routing so clicking a view in the sidebar navigates to `/views/:id`.
- **Top Filter Bar:** The page should display the view's name and type. The top bar should have filter controls (Project dropdown, Assignee dropdown).
- **Save Filters:** When a filter is changed, a "Save View" button should become active (or auto-save), firing a `PUT /api/views/{id}` to persist the new filter JSON.
- **Data Fetching:** The Kanban/Backlog/Gantt components should apply the current filters when fetching `GET /api/tasks`.

## Execution Order
1. Implement `TaskView` DB model and auto-migrate.
2. Build backend CRUD API for views.
3. Update Sidebar UI (remove hardcoded links, add `+` and `...` menus, fetch dynamic views).
4. Update `Tasks.tsx` to read the view configuration and persist filter changes.
5. Seed default views (one of each type) on startup if none exist for a space.
