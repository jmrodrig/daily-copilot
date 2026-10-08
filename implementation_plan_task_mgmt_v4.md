# Implementation Plan: Advanced Filters Expansion (v4)

## Overview
The user requested that the "Advanced Filters" be capable of filtering by *any* of the fields in the task, not just Custom Fields and Due/Start dates. We will expand both the backend API and frontend UI to cover all remaining task fields (Priority, Status, Is Gantt Task, Is Milestone, Has Linked Note, and Start bounds).

## Branching
- Continue on `feat/task-mgmt-improvements`.
- Update relevant backend and frontend tests.

## 1. Backend API (`backend/main.py`, `backend/schemas.py`)
- Expand `TaskViewFilters` in `schemas.py`:
  - `priority`: `Priority | None`
  - `status`: `Status | None`
  - `is_gantt_task`: `bool | None`
  - `is_milestone`: `bool | None`
  - `has_note`: `bool | None`
  - `start_after`: `date | None`
  - `start_before`: `date | None`
- Expand the `list_tasks` (`GET /api/tasks`) parameters in `main.py` to accept:
  - `priority: Priority | None = None`
  - `is_gantt_task: bool | None = None`
  - `is_milestone: bool | None = None`
  - `has_note: bool | None = None`
  - `start_after: date | None = None`
  - `start_before: date | None = None`
  *(Note: `status` is already a parameter, but we need to ensure it's exposed correctly to advanced filters).*
- Update the SQLAlchemy query in `list_tasks` to apply these new filters:
  - `Task.priority == priority`
  - `Task.is_gantt_task == is_gantt_task`
  - `Task.is_milestone == is_milestone`
  - `has_note`: check `Task.note_path.is_not(None)` vs `Task.note_path.is_(None)`
  - `start_after`: `Task.start_date >= start_after`
  - `start_before`: `Task.start_date <= start_before`

## 2. Frontend Models (`desktop/src/lib/tasks.ts` or `desktop/src/components/AdvancedFilters.tsx`)
- Ensure the `ViewFilters` type (or equivalent used for state) mirrors the backend's new capabilities.
- Serialize these new filters into URL query parameters (e.g. `&priority=high&is_gantt_task=true&start_after=2026-10-01`).

## 3. Frontend UI (`desktop/src/components/AdvancedFilters.tsx`)
- Add new `Labelled` sections for the missing fields inside the collapsible:
  - **Priority:** Dropdown (Any, Low, Normal, etc.)
  - **Status:** Dropdown (Any, Backlog, To Do, In Progress, Blocked, Done, Archived)
  - **Is Gantt Task:** Toggle/Select (Any, Yes, No)
  - **Is Milestone:** Toggle/Select (Any, Yes, No)
  - **Has Linked Note:** Toggle/Select (Any, Yes, No)
  - **Start on or after:** Date input
  - **Start on or before:** Date input
- Make sure they all use the existing filter state setter mechanics (`set` function) and clean up correctly when reset.
