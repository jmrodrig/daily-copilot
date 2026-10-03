# Implementation Plan: Phase 6.1 - Task Ownership & Check-in Filtering
**Task ID:** phase-6.1

## Goal
Introduce task ownership so Jose can "Claim" tasks from the Morning List, and filter the Evening Check-in to only show tasks that are assigned to him.

## Scope
### Backend (FastAPI + SQLite)
- **Database Model:** Add `assignee: Mapped[str | None]` to the `Task` model in `backend/models.py`. (Use a migration or just rely on SQLite `ALTER TABLE` if doing it manually, but since SQLAlchemy `create_all` doesn't alter tables, you may need to write a tiny script to `ALTER TABLE tasks ADD COLUMN assignee VARCHAR;` in the db).
- **Schemas:** Update `schemas.py` to include `assignee: str | None = None` on the Task schemas.
- **Endpoints:** 
  - Add a `PATCH /api/tasks/{task_id}` endpoint to allow updating a task's `assignee` (and potentially `status`).
  - Ensure `GET /api/triage` includes the `assignee` field in the returned `TriageItem` payload.
- Write tests to verify claiming a task and the updated schemas.

### Frontend (React + Vite)
- **Morning List (TriageBoard.tsx):** 
  - Add a small, subtle "Claim" button (or a user avatar icon) next to Gantt tasks that have no assignee.
  - Clicking "Claim" should `PATCH` the task to set `assignee: "Jose"` (and optionally set `status: "in_progress"` if it isn't already).
  - If a task is already claimed by "Jose", show a small indicator (e.g., "👤 Jose" or an active avatar).
- **Evening Check-in (EveningCheckIn.tsx):**
  - Update the task list filter on the left column. 
  - It should ONLY display Gantt tasks where `assignee === "Jose"`.
  - (The user also requested "only in progress tasks", so ensure it excludes tasks that are just "todo" if that makes sense, or assume claiming it makes it in-progress).

## Relevant Context
- The user is managing a massive Gantt chart but only personally executing a subset of those tasks. Claiming a task is their way of saying "I am working on this today."
- The SQLite database already exists, so adding the `assignee` column will require a quick `ALTER TABLE` execution in `backend/main.py` startup or a manual script, because SQLAlchemy `Base.metadata.create_all()` does not add columns to existing tables.

## Files to Modify / Create
- `backend/models.py`
- `backend/schemas.py`
- `backend/main.py`
- `desktop/src/components/TriageBoard.tsx`
- `desktop/src/pages/EveningCheckIn.tsx`

## User-Driven Manual Test Plan
1. Open the Dashboard.
2. In the Morning List, find a C7801 Gantt task and click "Claim".
3. Verify it shows an indicator that it is assigned to you.
4. Navigate to the Evening Check-in tab.
5. Verify ONLY the task(s) you claimed appear in the left-hand check-off list!
