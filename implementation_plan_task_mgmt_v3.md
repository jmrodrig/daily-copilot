# Implementation Plan: Task Management Improvements v3

## Overview
This plan implements advanced task management requested features: editing custom fields with drop-down color coding, Gantt chart coloring by project or custom fields, adding colors to Projects, and an advanced collapsible task filter.

## Branching
- Continue working on the same branch: `feat/task-mgmt-improvements`
- Make sure to add/update tests for new features.

## A) Custom Field Editing & Dropdown Color Coding
### Backend
- Update the custom field schema (`backend/schemas.py`) to support a `colors: dict[str, str]` property for "dropdown" fields. This will map a dropdown option string to a valid color (e.g., hex code or Tailwind class).
- Ensure the Space update logic allows replacing/editing the existing custom fields schema gracefully (without wiping existing task data unless a field is explicitly deleted).

### Frontend
- **Space Preferences:** Allow clicking on an existing custom field to edit its name, type, and options. For "Dropdown" fields, present a color picker/selector next to each option (e.g., a set of predefined colors or a hex input).
- **Task Rendering (Kanban & Task Panel):** When a task has a custom field of type "Dropdown", and that option has a color defined in the schema, render it visually as a colored pill (badge) on the Kanban card face and inside the Task panel.

## B & C) Project Colors and Gantt Chart Coloring
### Backend
- Update the `Project` model in `backend/models.py` and `schemas.Project` to include an optional `color: str | None` field.
- Update `ProjectUpdate` schema and ensure the endpoint allows changing the project color.

### Frontend
- **Project Settings:** Add a color picker to the Project creation/editing form or panel.
- **Gantt Chart (`GanttChart.tsx`):**
  - Change the default bar color to use the Project's color (falling back to the current default blue if none is set).
  - Add a "Color by:" control to the Gantt chart UI. The options should be "Project" (default) or any of the Space's Dropdown custom fields.
  - If colored by a Custom Field, the bar should use the color mapped to that task's selected dropdown option.

## D) Advanced Task Filtering
### Backend
- Expand `TaskViewFilters` in `backend/schemas.py` to support advanced filtering:
  - `custom_fields`: dictionary for matching specific custom field values.
  - `has_deadline`: boolean flag (true = not null, false = null).
  - `has_start_date`: boolean flag.
  - `due_after` / `due_before`: date filters for deadlines.
- Update the `GET /api/tasks` filtering logic in `backend/main.py` (or `backend/tasks.py`) to apply these new filters to the SQLAlchemy query.

### Frontend
- **Task Views (`Tasks.tsx` & `TaskListView.tsx`):**
  - Add an "Advanced Filters" collapsible section (using `<details>`/`<summary>` or a similar toggle UI) next to the standard filters.
  - Inside the collapsible, dynamically render inputs for the custom fields defined in the space.
  - Add controls for "Has Date", "Has No Date", "Due After", etc.
  - Ensure the filter state is properly serialized into the URL search params so views can be bookmarked/saved.
