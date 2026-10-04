# Implementation Plan: Phase 9 - Confluence/Jira Hybrid Architecture
**Task ID:** phase-9

## Goal
Restructure the application into a Confluence/Jira hybrid. Introduce "Spaces" for top-level isolation, a flexible nested "Content" folder tree (Confluence), a database-backed "Tasks" engine (Jira), and a dedicated "Templates" library.

## Scope
### 1. Database Schema (`backend/models.py`)
- **Space:** `id`, `name`, `created_at`
- **FolderMeta:** `id`, `space_id`, `path`, `is_project`, `is_reference`. (This tracks which folders in the file system act as Projects/Epics or Reference Data).
- **Task:** `id`, `space_id`, `project_id` (FK to FolderMeta), `title`, `status` (backlog, todo, in_progress, done), `start_date`, `due_date`, `assignee`.
- **TaskNoteLink:** `task_id`, `note_path` (Many-to-Many linking DB tasks to markdown files).

### 2. File System Migration
- Shift the base directory from `notes/` to `data/spaces/<space_id>/`.
- Inside each space:
  - `content/`: The flexible folder tree containing all user markdown notes.
  - `templates/`: The folder containing markdown templates.
- Write a startup migration script in `backend/main.py` that moves the existing `notes/` directory into `data/spaces/1/content/`, creates a "Default" Space in the DB, and creates `data/spaces/1/templates/`.

### 3. Frontend UI: Sidebar (`desktop/src/components/Sidebar.tsx`)
- **Space Switcher:** Dropdown at the top to select the active Space.
- **Tasks Section:** Links to "Kanban", "Backlog", and "Gantt" views.
- **Content Section:** A recursively rendered, infinitely nestable folder tree reading from `content/`. Right-clicking a folder should allow marking it as a "Project" (turns icon blue/adds label) or "Reference Data" (adds a visual indicator).
- **Templates Library:** At the absolute bottom of the sidebar, a "Templates" section reading from the `templates/` directory.

### 4. Frontend UI: Tasks Area (`desktop/src/pages/`)
- Build a generic Tasks layout with tabs for Kanban, Backlog, and Gantt.
- These views must query the new `Task` SQLite table, NOT parse markdown files.
- Add filters for Project and Assignee.

### 5. Backend & Agent API Updates
- Create endpoints for `GET /api/spaces`, `GET /api/tree?space_id=...`, `POST /api/tasks`, etc.
- Update `agent.py`: When the agent receives a chat, it must restrict file searches and context to the active `space_id`. It must auto-include contents from any folders marked `is_reference=True` in that space. If the user is viewing a note inside an `is_project=True` folder, inject that project's tasks into the context.

## Execution Order
1. Implement DB Schema & File System Migration.
2. Build Backend CRUD APIs for Spaces, FolderMeta, and Tasks.
3. Overhaul Frontend Sidebar and Routing (Spaces context).
4. Build Kanban/Backlog Task Views.
5. Update Co-pilot Agent Context injection.
