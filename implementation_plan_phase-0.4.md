# Implementation Plan: Phase 0.4 - Data Schemas and File Layer
**Task ID:** phase-0.4

## Goal
Implement the shared data schemas and the markdown file layer to handle parsing and writing wiki notes with front-matter, enforcing agent access modes.

## Scope
- Create `backend/schemas.py` containing Pydantic models for the data model: `Project`, `Task`, `Subtask`, `Link`, `Note`, `Person`, `Capture`, and `Email`.
- Create `backend/file_layer.py` containing utilities to parse markdown files with YAML front-matter and write them back.
- Implement logic in `file_layer.py` to enforce the three agent access modes (`read_only`, `ask_first`, `write_directly`).
- Create `backend/tests/test_file_layer.py` to ensure markdown parsing and writing works flawlessly without data loss.

## Relevant Context
- Every note is a markdown file with properties at the top (YAML front-matter).
- The agent access mode is enforced server-side, not just in the UI. 
- Ensure `pyyaml` is added to `backend/requirements.txt` for front-matter parsing.

## Files to Modify / Create
- `backend/schemas.py` (New)
- `backend/file_layer.py` (New)
- `backend/tests/test_file_layer.py` (New)
- `backend/requirements.txt` (Modify)

## Interfaces
- `read_note(filepath: str) -> dict`
- `write_note(filepath: str, content: str, frontmatter: dict, access_mode: str) -> bool`

## Constraints
- Ensure the file layer operates relative to a configurable `NOTES_DIR` (from `config.py`).
- Do not build the UI yet.

## User-Driven Manual Test Plan
1. Open PowerShell in `C:\Users\designer\Documents\assistant\copilot\backend`.
2. Run `pip install -r requirements.txt` to install the new `pyyaml` dependency.
3. Run `pytest backend/` and verify the file layer tests pass alongside the existing health tests.

## Out of Scope
- Actually connecting the file layer to the database or LLM endpoints.
