# Implementation Plan: Phase 1.5 - Version History Integration
**Task ID:** phase-1.5

## Goal
Implement a unified SQLite `history` table that captures full JSON snapshots and the "source" (actor/model) for every change to DB rows (`Task`, `Project`, `Link`) and file-based `Note`s. Introduce soft-deletes so no data is ever permanently removed.

## Scope
- Create a `HistoryRecord` SQLAlchemy model in `backend/models.py`. It should store:
  - `entity_type` (e.g. 'Task', 'Project', 'Note', 'Link')
  - `entity_id` (string/int)
  - `action` ('create', 'update', 'delete', 'rename')
  - `source` (string, e.g. 'manual', 'gemini', 'cli_import')
  - `timestamp` (datetime)
  - `snapshot` (JSON object holding the full state)
- Implement SQLAlchemy event listeners in `backend/database.py` (or a new `history.py`) to automatically intercept inserts/updates on DB models and write to the `HistoryRecord` table.
- Modify the database models to support soft-deletes (add `deleted_at` column to `Base` or all relevant models). Replace `delete()` calls in `cli_import.py` and cascade configurations with soft-deletes.
- Modify `backend/file_layer.py` to also write to the `HistoryRecord` table whenever `write_note` is called. For files, `entity_id` will be the file path.
- Add tests to ensure version history is accurately recorded for both DB operations and file layer operations.

## Relevant Context
- Soft deletes are replacing DB cascades. If a project is soft-deleted, we might need to handle its tasks appropriately, but for now, just ensure the `deleted_at` flag is respected by the application.
- `HistoryRecord.snapshot` should be a full JSON dump of the entity's state at the moment of the change.
- In `file_layer.py`, since we don't have a DB session directly injected, you may need to open a short-lived session inside `write_note` to append the history record.

## Files to Modify / Create
- `backend/models.py` (Add HistoryRecord, add `deleted_at` to models)
- `backend/database.py` (Attach SQLAlchemy event listeners)
- `backend/file_layer.py` (Inject history recording on write/delete)
- `backend/cli_import.py` (Change `.delete()` to `.update({deleted_at: now()})`)
- `backend/tests/test_history.py` (New)

## Interfaces
- `HistoryRecord` table in SQLite.
- All ORM models gain a `deleted_at: datetime | None` field.

## User-Driven Manual Test Plan
1. Run `pytest backend/` to ensure the new history listeners work without breaking the existing DB and file tests.
2. Run `python cli_import.py "../docs/gantt/C7801 Project Plan.pdf"` (using the mock JSON if the API fails) to trigger DB inserts.
3. Use `sqlite3 copilot.db "SELECT * FROM history;"` to verify the audit trail was recorded.

## Out of Scope
- A UI for viewing the history timeline (just the backend capability is needed now).
