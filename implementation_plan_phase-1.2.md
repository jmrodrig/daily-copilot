# Implementation Plan: Phase 1.2 - Gantt CLI Review and Import
**Task ID:** phase-1.2

## Goal
Build a terminal CLI script that executes the Gantt extraction, presents the JSON to the user for review, and upon approval, saves the parsed data into the SQLite database.

## Scope
- Create `backend/models.py` with SQLAlchemy ORM models for `Project`, `Task`, and `Link` mapping to the Pydantic schemas in `schemas.py`.
- Update `backend/database.py` to import these models so `Base.metadata.create_all` creates the tables in `copilot.db`.
- Create `backend/cli_import.py`, a command-line script taking a PDF file path:
  1. Calls `extract_gantt_data`.
  2. Pretty-prints a summary (e.g., project name, task count, milestone count).
  3. Prompts the user: "Approve and import to database? [Y/N]".
  4. If Yes:
     - Creates/Updates the `Project` in the database.
     - Inserts the `Task`s (setting `is_gantt_task=True`).
     - Inserts the `Link`s.
- Create tests for `cli_import.py` and the ORM models.

## Relevant Context
- The parsed Gantt tasks are shop floor tasks. They should be marked as `is_gantt_task=True`.
- Re-importing the same project should overwrite or update existing Gantt tasks for that project (you can delete old Gantt tasks for that project code and insert new ones to keep it simple for now).

## Files to Modify / Create
- `backend/models.py` (New)
- `backend/cli_import.py` (New)
- `backend/database.py` (Modify to import models)
- `backend/tests/test_cli_import.py` (New)

## Interfaces
- `$ python cli_import.py ../docs/gantt/C7801_Project_Plan.pdf`

## Constraints
- Do not write any web UI. This is strictly a terminal interface using `input()`.
- Use SQLAlchemy 2.0 paradigms.

## User-Driven Manual Test Plan
1. Open PowerShell in `backend/`.
2. Ensure API key is set in `.env`.
3. Run `python cli_import.py "../docs/gantt/C7801 Project Plan.pdf"`.
4. Review the terminal output and press 'Y'.
5. Verify no crash occurs and data is stored.

## Out of Scope
- Frontend dashboard diffing (this covers the minimal requirement via CLI).
