# Implementation Plan: List Views & Multi-Select Filters

## Goal
Improve the Backlog and Task List views by adding column selection and inline task creation at the bottom. Additionally, upgrade the advanced filters to support multiple selections (e.g., selecting multiple priorities or statuses).

## Branch
Checkout branch `feat/list-and-filters`

## A. List View Improvements (TaskListView & Backlog)
### 1. Column Selection
- In both `TaskListView.tsx` and `Tasks.tsx` (the `Backlog` component), add a "Columns" dropdown/popover menu above the table toolbar (near the search or bulk edit buttons).
- The dropdown should list all available columns (e.g., Project, Title, Status, Assignee, Priority, Dates, plus any active Custom Fields) with checkboxes.
- Save the visibility state of these columns in `localStorage` (e.g., `copilot:list-columns` and `copilot:backlog-columns`) so preferences persist.
- Dynamically render the `<th>` and `<td>` elements based on the visible columns.

### 2. Inline Task Creation
- **Remove** the existing "new task" panel at the top of the Backlog and TaskList.
- **Add** a `[ + ] Add Task` button at the very bottom of the table.
- When clicked, it should render an inline editable row at the bottom of the table.
- **Auto-populate:** Pass the current `filters: ViewFilters` down to `TaskListView` and `Backlog`. When creating this new task row, prepopulate its fields matching the active filters (e.g., if `filters.priority` contains `["high"]`, set the new task's priority to `high`). For array filters, if only one value is selected, use it; if multiple, pick the first or leave empty.

## B. Multi-Select Filters
### 1. Backend Schema (`backend/schemas.py`)
- Update `TaskViewFilters`:
  - `priority: list[Priority] | None = Field(default=None)`
  - `status: list[Status] | None = Field(default=None)`
  - `project_id: list[int] | None = Field(default=None)`
  - `assignee: list[str] | None = Field(default=None)`
- **Crucial:** Add a `@model_validator(mode="before")` on `TaskViewFilters` to seamlessly convert older saved string/int values into single-item lists, preventing crashes when loading old views from the database.

### 2. Backend Logic (`backend/main.py`)
- Update `def list_tasks` to accept `Query(default=None)` as lists:
  - `project_id: list[int] | None = Query(default=None)`
  - `assignee: list[str] | None = Query(default=None)`
  - `status: list[Status] | None = Query(default=None)`
  - `priority: list[Priority] | None = Query(default=None)`
- Change the SQLAlchemy filtering (e.g., from `Task.status == status` to `Task.status.in_(status)`).

### 3. Frontend Filters State (`desktop/src/lib/views.ts`)
- Update `ViewFilters` to reflect arrays for `priority`, `status`, `project_id`, `assignee`.
- Update `filtersFromParams` to use `params.getAll("key")` for these fields.
- Update `writeFilterParams` to loop and `params.append("key", val)` for each item in the arrays.
- Adjust `sameFilters` and `NO_ADVANCED_FILTERS` (use empty arrays `[]` instead of `null` for these).

### 4. Frontend Filter UI (`AdvancedFilters.tsx` & TaskBoard Headers)
- Replace standard `<select>` tags for Priority, Status, Project, and Assignee in the filter bar with a custom multi-select dropdown (as requested in the screenshot: a button that drops down a list of checkboxes).
- Include an "Any" option at the top of the dropdown that clears the array.
