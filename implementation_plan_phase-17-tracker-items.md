# Implementation Plan: Phase 17 — Tracker Items 13, 14, 25, 28, 33

**Task ID:** `phase-17-tracker-items`  
**Git Branch:** `phase-17-tracker-items`  
**Target Roles:**
- **Architect & Reviewer:** Nero (Google Antigravity / Gemini)
- **Implementer:** Jibby (Claude via Claude Code)

---

## 1. Overview & Scope

This implementation plan addresses five user-requested tracker items from `tracker.md`:

1. **Item #13 — Auto-Open & Focus Side Panel on Task Creation:**
   When adding a task in a list (List view, Backlog) or in Kanban, automatically open and focus on the side task panel (`TaskPanel`) once the "Add task" button or Enter is pressed.

2. **Item #14 — Column Sorting in Task Lists:**
   Allow sorting columns in task lists (`TaskListView` and `Backlog`). Clicking column headers toggles between ascending (`asc`), descending (`desc`), and default sort, with visual sort indicator arrows.

3. **Item #25 — Add Tags to Tasks:**
   Allow users to add, edit, and remove tags on tasks directly in the `TaskPanel` (with auto-suggestions from the space's existing tags, matching `NoteTags`), support tags in inline task creation / tables (`LIST_COLUMNS`, `BACKLOG_COLUMNS`), and bulk edit dialog.

4. **Item #28 — Multiple Assignees for Tasks:**
   Allow tasks to have multiple assignees. Update backend models and schemas with `assignees: list[str]` (while keeping `assignee: str | None` in sync for full backward compatibility), update filters and queries, and update frontend components (`AssigneesSelect` picker, avatar clusters on Kanban cards, and List/Backlog assignee cells).

5. **Item #33 — De-emphasize Done Tasks on Kanban Board:**
   In the Kanban board, remove highlights (no urgent colored left borders or warning backgrounds) and grey out / dim tasks that are in `done` status.

---

## 2. Invariants & Dev Server Safety

- **Server Safety Rule:** Dev servers (`uvicorn` port 8000 and `vite` port 5173) MUST remain STOPPED during all file edits and test generation. They are only started during manual user verification.
- **Branch Invariant:** All changes must be executed on branch `phase-17-tracker-items`. Never commit directly to `main`.
- **Backward Compatibility:** Single `assignee` string field must stay in sync with `assignees` array so existing APIs, SQLite rows, and Gantt charts continue functioning seamlessly.

---

## 3. Technical Specifications

### Item 13: Auto-Open & Focus Side Panel on Task Creation
- **Kanban (`desktop/src/pages/Tasks.tsx`):**
  - In `KanbanAddCard`: when `sendJson("POST", "/api/tasks", body)` succeeds, call `onCreated(created)`.
  - In `Tasks` (`Tasks.tsx`): in `addTask = (task: TaskItem) => ...`, call `openTask(task.id)`.
- **Task List View (`desktop/src/pages/TaskListView.tsx`):**
  - In `TaskListView`: when a task is created via `NewTaskRow` `onCreated`, call `openTask(task.id)`.
- **Backlog (`desktop/src/pages/Tasks.tsx`):**
  - In `Backlog`: when `NewTaskRow` `onCreated` is invoked, call `openTask(task.id)`.
- **Focus side task panel (`desktop/src/components/TaskPanel.tsx`):**
  - Ensure the task details container (`<section aria-label="Task details" ...>`) has `tabIndex={-1}` and receives focus when loaded, or focus the title `TextField` / first input so keyboard navigation seamlessly lands in the opened panel.

### Item 14: Column Sorting in Task Lists
- **Files:** `desktop/src/pages/TaskListView.tsx` and `desktop/src/pages/Tasks.tsx` (Backlog).
- **State:**
  - `sortColumn: string | null` (defaults to null or current default).
  - `sortDirection: "asc" | "desc"` (defaults to `"asc"`).
- **Header Interaction:**
  - Column headers (`th`) become clickable buttons with `cursor-pointer select-none hover:text-text-primary`.
  - Clicking a header toggles:
    - If `sortColumn !== col.id`: set `sortColumn = col.id`, `sortDirection = "asc"`.
    - If `sortColumn === col.id && sortDirection === "asc"`: set `sortDirection = "desc"`.
    - If `sortColumn === col.id && sortDirection === "desc"`: reset `sortColumn = null` (or toggle to `"asc"`).
  - Render sort arrow indicator next to column label: `▲` (asc) or `▼` (desc) when active, subtle `↕` on hover.
- **Sorting Logic:**
  - `title`: alphabetical `a.title.localeCompare(b.title)`
  - `project`: alphabetical `(a.project_code || "").localeCompare(b.project_code || "")`
  - `status`: workflow status order or `STATUS_LABELS[a.status].localeCompare(STATUS_LABELS[b.status])`
  - `assignee`: alphabetical `((a.assignees?.join(", ") || a.assignee) || "").localeCompare(...)`
  - `priority`: `PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]` (urgent > high > normal > low; inverted for desc)
  - `start`: chronological `(a.start_date || "9999-99-99").localeCompare(...)` (nulls last)
  - `due`: chronological `(a.deadline || "9999-99-99").localeCompare(...)` (nulls last)
  - `tags`: alphabetical `(a.tags || []).join(", ").localeCompare((b.tags || []).join(", "))`
  - `cf:<id>`: compare custom field values (strings, numbers, booleans, dates)

### Item 25: Add Tags to Tasks
- **Task Panel (`desktop/src/components/TaskPanel.tsx`):**
  - Replace static `<TagPills tags={task.tags} />` in `TaskFields` with interactive tag manager component (`TaskTags`):
    - Shows existing tags as `#tag` pills (project codes colored in their project color).
    - Hovering a pill reveals an `×` remove button: clicking calls `onPatch({ tags: task.tags.filter(t => t !== tag) })`.
    - "+ Add tag" button opens an inline tag input.
    - While typing, fetches existing space tags from `GET /api/spaces/${spaceId}/tags` and displays a dropdown of matching suggestions with keyboard navigation (Up/Down/Enter).
    - Enter or clicking a suggestion adds the tag (sanitized / lowercased / deduplicated) and calls `onPatch({ tags: [...task.tags, newTag] })`. Escape closes the input.
- **Columns in List View and Backlog:**
  - Add `{ id: "tags", label: "Tags" }` to `LIST_COLUMNS` (`TaskListView.tsx`) and `BACKLOG_COLUMNS` (`Tasks.tsx`).
  - Render cell: `<TagPills tags={task.tags} />`.
- **Bulk Edit (`desktop/src/components/BulkEditDialog.tsx`):**
  - Add tag editing support to bulk update selected tasks.

### Item 28: Allow Multiple Assignees for Tasks
- **Backend Models (`backend/models.py`):**
  - In `Task` model:
    ```python
    assignees: Mapped[list[str] | None] = mapped_column(JSON, default=list)
    ```
    Keep existing `assignee: Mapped[str | None]` column.
    `_add_missing_columns` in `backend/database.py` will automatically add `assignees JSON` column to SQLite on initialization.
- **Backend Schemas (`backend/schemas.py`):**
  - In `Task`, `TaskItem`, `TaskCreate`, `TaskUpdate`:
    Add `assignees: list[str] = Field(default_factory=list)`.
    Normalize synchronization:
    - If `assignees` is supplied: `assignee = assignees[0] if assignees else None`.
    - If only `assignee` is supplied: `assignees = [assignee.strip()] if assignee and assignee.strip() else []`.
- **Backend API & Endpoints (`backend/main.py`):**
  - In `_task_items`: return `assignees=t.assignees if t.assignees is not None else ([t.assignee] if t.assignee else [])`.
  - In `list_tasks` filter:
    When `assignee` query parameter is provided (`?assignee=Alice`), match if `Task.assignee` is in names OR if any name in `Task.assignees` is in names.
  - In `update_task` (`PATCH /api/tasks/{id}`) and `create_task` (`POST /api/tasks`):
    Ensure both `assignees` and `assignee` are populated and persisted.
- **Frontend Types (`desktop/src/lib/tasks.ts`):**
  - In `TaskItem`, `TaskCreate`, `TaskPatch`:
    Add `assignees?: string[]`.
  - Add helper:
    ```typescript
    export function taskAssignees(task: Pick<TaskItem, "assignee" | "assignees">): string[] {
      return task.assignees && task.assignees.length > 0
        ? task.assignees
        : (task.assignee ? [task.assignee] : []);
    }
    ```
- **Frontend People & Picker (`desktop/src/lib/people.tsx`):**
  - Create `AssigneesSelect` (multi-assignee selector) supporting:
    - Multiple selections from `people` with checkboxes.
    - Displaying avatar medallions for all selected assignees with `×` remove buttons.
    - Search filter by person name.
- **Frontend Views (`TaskPanel.tsx`, `Tasks.tsx`, `TaskListView.tsx`):**
  - In `TaskPanel.tsx`: use `AssigneesSelect` for the Assignee field.
  - In `Tasks.tsx` (`KanbanCard`): render avatar badges for all `taskAssignees(task)`. When multiple, show a clean avatar cluster with tooltips.
  - In `TaskListView.tsx` and `Backlog`: render badges/names for all `taskAssignees(task)`.

### Item 33: Remove Highlights and Grey Out Done Tasks in Kanban
- **File:** `desktop/src/pages/Tasks.tsx` -> `KanbanCard`
- **Logic:**
  ```typescript
  const isDone = task.status === "done";
  ```
  When `isDone`:
  - **No Urgent Highlighting:** Do NOT apply urgent border (`border-l-4 border-accent`) or urgent tinted background (`bg-accent/[0.06]`).
  - **No Overdue Alert:** Do NOT display overdue/late styling.
  - **Done Styling:**
    - Card container: `opacity-60 bg-surface-panel/40 border-border-default/60 hover:opacity-90 transition-opacity`.
    - Title: `text-text-muted` (subdued, completed appearance).
    - Badges/tags: muted or subdued styling.

---

## 4. Proposed Changes File by File

### Backend
1. `backend/models.py`:
   - Add `assignees` JSON column to `Task`.
2. `backend/schemas.py`:
   - Add `assignees` to `Task`, `TaskItem`, `TaskCreate`, `TaskUpdate`. Add synchronization validators.
3. `backend/main.py`:
   - Map `assignees` in `_task_items`.
   - Update `list_tasks` filter to check `assignees`.
   - Update `update_task` to handle `assignees`.
4. `backend/tests/test_task_mgmt.py`:
   - Add tests for multiple assignees creation, updating, filtering, and tag management.

### Frontend
5. `desktop/src/lib/tasks.ts`:
   - Add `assignees?: string[]` to `TaskItem`, `TaskCreate`, `TaskPatch`.
   - Add helper `taskAssignees`.
6. `desktop/src/lib/people.tsx`:
   - Implement `AssigneesSelect` multi-select component.
7. `desktop/src/components/TaskPanel.tsx`:
   - Replace static tags with interactive `TaskTags` editor (add/remove, suggestions).
   - Use `AssigneesSelect` for assignees.
   - Set `tabIndex={-1}` and focus panel/title on mount.
8. `desktop/src/pages/Tasks.tsx`:
   - In `KanbanCard`: grey out done tasks and strip urgent highlights; render multiple assignee avatars.
   - In `KanbanAddCard`: call `openTask` on created task.
   - In `Backlog`: add column sorting with clickable headers; add `"tags"` column; call `openTask` on created task.
9. `desktop/src/pages/TaskListView.tsx`:
   - Add column sorting on table headers with asc/desc indicator.
   - Add `"tags"` to `LIST_COLUMNS`.
   - In `NewTaskRow` completion: call `openTask(created.id)`.
10. `desktop/src/components/BulkEditDialog.tsx`:
    - Add support for updating tags in bulk.

---

## 5. Verification Plan

### Automated Verification
1. Run backend pytest suite:
   ```powershell
   pytest backend/tests/test_api.py backend/tests/test_task_mgmt.py
   ```
   Ensure all tests pass.
2. Run frontend TypeScript build:
   ```powershell
   npm --prefix desktop run build
   ```
   Ensure 0 compile/type errors.

### Manual User-Driven Verification Steps
*(Note: Start dev servers only for this step using `start_tray.cmd` or `pythonw scripts\copilot_tray.pyw`)*
1. **Verify Item 13 (Auto-open and focus side panel):**
   - In **Tasks > Kanban**, click "+ Add task" in "To do" column, enter title "Test Item 13", press Enter.
   - Verify the side panel opens immediately with "Test Item 13" loaded and focused.
   - In **Tasks > List**, click "+ Add task", enter title "Test Item 13 List", press Enter.
   - Verify the side panel opens immediately with the created task.
2. **Verify Item 14 (Column sorting in task lists):**
   - In **Tasks > List**, click the "Task" header. Check that tasks sort A-Z and an up arrow appears. Click again, verify Z-A sort with down arrow.
   - Click "Due" header, verify tasks sort by date with null dates at the end.
   - Check that sorting works similarly in **Tasks > Backlog**.
3. **Verify Item 25 (Add tags to tasks):**
   - Open any task in the side panel.
   - In the tags section, click "+ Add tag". Type a tag name (observe space tag suggestions). Press Enter.
   - Verify tag appears as a `#tag` pill.
   - Hover over the tag pill and click the `×` button to verify tag removal.
   - In **Tasks > List**, open "Columns" and enable "Tags". Verify task tags are visible in the table.
4. **Verify Item 28 (Multiple assignees):**
   - In the side task panel, open the Assignee picker. Select multiple people (e.g. Jose and another contact).
   - Verify multiple assignee avatar badges appear in the panel.
   - In Kanban, view the task card and verify all assignee avatars are displayed.
   - In **Tasks > List**, verify all assignees are shown in the Assignee column.
5. **Verify Item 33 (Grey out done tasks on Kanban):**
   - In Kanban, set an urgent task's status to "Done" (or drag to Done column).
   - Verify that the bright red left border and urgent background highlight disappear.
   - Verify that the card is greyed out with muted opacity and muted text.
