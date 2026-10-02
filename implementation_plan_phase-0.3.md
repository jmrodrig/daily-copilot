# Implementation Plan: Phase 0.3 - Backend Skeleton
**Task ID:** phase-0.3

## Goal
Initialize the Python backend skeleton behind Tailscale, configure environment variables and secrets handling, and set up the SQLite database connection.

## Scope
- Create `backend/requirements.txt` with `fastapi`, `uvicorn`, `sqlalchemy`, and `pydantic-settings`.
- Create `backend/main.py` with a basic FastAPI app and a `/health` endpoint.
- Create `backend/config.py` using `pydantic-settings` to handle environment configurations (database path, model endpoints, API keys).
- Create `backend/database.py` initializing a SQLAlchemy SQLite connection to a local `copilot.db` file.
- Add `backend/README.md` explaining how to start the dev server locally.

## Relevant Context
- Backend is local only and exposed to the mobile app exclusively via Tailscale. 
- API keys (like Gemini) must be handled gracefully (loaded from `.env` or system environment variables) and never hardcoded.

## Files to Modify / Create
- `backend/requirements.txt` (New)
- `backend/main.py` (New)
- `backend/config.py` (New)
- `backend/database.py` (New)
- `backend/README.md` (New)

## Interfaces
- Local backend API running on `localhost:8000`.

## Constraints
- Do not run the server as a daemon during the implementation step.
- Ensure the SQLite DB path resolves relative to the `backend/` directory or app data.

## User-Driven Manual Test Plan
1. Open PowerShell in `C:\Users\designer\Documents\assistant\copilot\backend`.
2. Run `pip install -r requirements.txt`.
3. Run `uvicorn main:app --reload`.
4. Open your browser and navigate to `http://localhost:8000/health`. You should see `{"status": "ok"}`.
5. Verify that `copilot.db` was created in the `backend/` directory.

## Out of Scope
- Actual schema definitions (projects, tasks, links). That is reserved for Phase 0.4.
- Integration with LiteLLM or Claude API.
