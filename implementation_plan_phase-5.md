# Implementation Plan: Phase 5 - Daily Triage Engine
**Task ID:** phase-5

## Goal
Build the Daily Triage Engine to aggregate and rank Gantt tasks alongside ad-hoc Capture notes, producing a focused "Morning List" for the user.

## Scope
### Backend (FastAPI)
- Create a new endpoint `GET /api/triage` in `backend/main.py`.
- **Aggregation Logic:** 
  1. Query the SQLite database for Gantt tasks that are currently active (i.e. `start_date` <= Today AND `status != 'done'`).
  2. Use `file_layer.py` to scan the `Inbox/` and `{Project}/Notes-in/` directories for Markdown notes created via the Android Capture App. Read their frontmatter.
- **Ranking Algorithm:** Sort the aggregated items into a unified list based on priority:
  - Rank 1: Overdue Gantt tasks.
  - Rank 2: Gantt tasks scheduled for today.
  - Rank 3: Capture notes with `priority: High`.
  - Rank 4: Capture notes with `priority: Normal`.
  - Rank 5: Gantt tasks with future start dates but within a 7-day lookahead window.
  - Rank 6: Capture notes with `priority: Low`.
- Return a structured JSON list of `TriageItem` schemas.
- Write tests in `backend/tests/test_api.py`.

### Frontend (React + Vite)
- Create a new `TriageBoard.tsx` component in `desktop/src/components/`.
- This component should fetch data from `GET /api/triage`.
- Render the data as a clean, ranked "Morning List" on the Dashboard (perhaps below or alongside the Gantt chart).
- Differentiate visually between Gantt Tasks and Ad-hoc Notes. Show tags for Priority and Project.
- Stick to the dark-mode design tokens (`shared/design-tokens.json`).

## Relevant Context
- Capture notes are raw markdown files, so you must parse their frontmatter to determine their project, priority, and creation date.
- The Triage engine acts as the primary "what do I do today" interface, separating urgent shop-floor tasks from ad-hoc noise.

## Files to Modify / Create
- `backend/main.py` (Add endpoint)
- `backend/schemas.py` (Add `TriageItem` schema)
- `backend/tests/test_api.py`
- `desktop/src/pages/Dashboard.tsx` (Add TriageBoard to layout)
- `desktop/src/components/TriageBoard.tsx` (New)

## User-Driven Manual Test Plan
1. Ensure there are Capture notes in the backend `notes/Inbox/` directory (created during Phase 2 testing).
2. Start the FastAPI backend and Vite frontend.
3. Verify the Dashboard now displays a "Morning List" featuring both the captured notes and the active C7801 shop-floor tasks, ranked logically.
