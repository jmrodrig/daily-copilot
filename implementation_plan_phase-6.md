# Implementation Plan: Phase 6 - Evening Check-in
**Task ID:** phase-6

## Goal
Build the Evening Check-in loop. This allows the user to quickly log their daily hours per project and check off completed Gantt tasks or notes, cleaning up the Triage Engine for tomorrow.

## Scope
### Backend (FastAPI + SQLite)
- **Database Model:** 
  - Add a `TimeLog` model to `backend/models.py` (inheriting from `Versioned` so it gets history tracking).
  - Fields: `id`, `date` (default today), `project_id` (foreign key, nullable), `task_id` (foreign key, nullable), `hours` (float), `notes` (string).
- **API Endpoint:** Create `POST /api/checkin` in `backend/main.py`.
  - Accepts a JSON payload containing:
    1. A list of task IDs to mark as `done` (this should update their `status` to `Status.DONE`, set `completed_at`, and update the `history` table).
    2. A list of time entries (Project Code, Hours, Notes) to insert into the `TimeLog` table.
- Update `backend/schemas.py` with the corresponding Pydantic schemas.
- Write tests in `backend/tests/test_api.py`.

### Frontend (React + Vite)
- Create a new `EveningCheckIn.tsx` component (rendered on a new route `/check-in`).
- **Sidebar Link:** Add an "Evening Check-in" link to the `Layout.tsx` sidebar.
- **UI Layout:**
  - A left column showing "Today's Active Tasks" (fetching from `/api/triage` and filtering for Tasks). Provide checkboxes to mark them as completed.
  - A right column featuring a "Time Sheet" form. Let the user add rows to log hours against specific projects (C7801, R5301, P5002, Inbox/Overhead).
  - A prominent "Submit Check-in" button that POSTs to `/api/checkin`.
  - On success, show a celebration message and redirect back to the Dashboard.

## Relevant Context
- The system uses application-level soft-deletes and version history. Make sure any changes to the models correctly trigger the SQLAlchemy event listeners (the mixin handles most of this).
- Marking a task as done is critical to keeping the Triage Engine clean, as it will stop it from showing up as "Overdue" tomorrow.

## Files to Modify / Create
- `backend/models.py` (Add TimeLog)
- `backend/schemas.py`
- `backend/main.py`
- `backend/tests/test_api.py`
- `desktop/src/components/Layout.tsx` (Add sidebar link)
- `desktop/src/pages/EveningCheckIn.tsx` (New page)
- `desktop/src/App.tsx` (Add routing)

## User-Driven Manual Test Plan
1. Start the FastAPI backend and Vite frontend.
2. Click the new "Evening Check-in" link in the sidebar.
3. Check off a few of the massive pile of overdue C7801 tasks.
4. Log 4 hours to C7801 and 2 hours to R5301.
5. Hit Submit.
6. Return to the Dashboard and verify the checked-off tasks have disappeared from the Morning List!
