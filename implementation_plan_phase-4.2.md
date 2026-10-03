# Implementation Plan: Phase 4.2 - Live Gantt Chart
**Task ID:** phase-4.2

## Goal
Build the core interactive feature of the Desktop Dashboard: a live Gantt chart rendering the shop-floor tasks from the SQLite database.

## Scope
### Backend (FastAPI)
- Create a new endpoint `GET /api/gantt` in `backend/main.py`.
- This endpoint should query the SQLite database (using SQLAlchemy models from `models.py`) to fetch all Projects and their associated Tasks.
- Return a structured JSON payload that easily maps to a Gantt component (e.g., grouping tasks by Project, sorting by `start_date`, and including `completion_percent`).
- Write tests in `backend/tests/test_api.py` to verify this endpoint returns valid data.

### Frontend (React + Vite)
- Create a bespoke, dark-mode `GanttChart.tsx` component in `desktop/src/components/`.
- The Gantt chart should be built cleanly using standard React/CSS (e.g., CSS Grid or Flexbox mapping dates to horizontal space). It does not need to be a massive third-party library—a custom calendar timeline is often faster and looks much more professional.
- Render the projects as swimlanes (horizontal rows), and render the tasks as rounded bars.
- The task bars should be colored according to their project (using `bg-project-c7801`, etc. defined in `tailwind.config.js`).
- Display the task `name` and `completion_percent` on or near the task bar.
- Update `Dashboard.tsx` to fetch `GET /api/gantt` on mount (using `fetch` or `axios`) and pass the data to the `GanttChart` component.

## Relevant Context
- The app must continue to strictly adhere to the `shared/design-tokens.json` color scheme. 
- You can compute the minimum start date and maximum end date from the fetched tasks to dynamically set the Gantt chart's overall timeline window.

## Files to Modify / Create
- `backend/main.py` (Add endpoint)
- `backend/schemas.py` (Add response schemas for the Gantt data)
- `backend/tests/test_api.py` (Add endpoint test)
- `desktop/src/pages/Dashboard.tsx` (Add fetch logic)
- `desktop/src/components/GanttChart.tsx` (New Component)

## User-Driven Manual Test Plan
1. Ensure the SQLite database `copilot.db` is populated (it should already be from Phase 1).
2. Start the FastAPI backend: `cd backend; uvicorn main:app --host 127.0.0.1 --port 8000`.
3. Start the Vite frontend: `cd desktop; npm run dev`.
4. Open the browser to the Desktop App.
5. Verify the Dashboard renders a beautiful, horizontally-scrolling Gantt timeline showing the extracted `C7801` tasks!
