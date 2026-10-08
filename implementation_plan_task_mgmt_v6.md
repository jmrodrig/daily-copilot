# Implementation Plan: Gantt Adjustments & Color By Persistence (v6)

## Overview
The user requested two specific refinements to the Gantt chart functionality:
1. **Invert Gantt Bar Fill:** Visually, the solid "fill" part of the bar should represent the *upcoming/remaining* portion of the task, while the *past/completed* portion should be the hollow outline (track). 
2. **Persist Color By Setting:** The "Color by" selector in the Gantt chart (Project vs Custom Field) currently resets on reload. This setting needs to be serialized to the view's filters so it persists in saved views and the URL.

## Branching
- Continue on `feat/task-mgmt-improvements`.

## 1. Frontend - Gantt Bar Rendering (`desktop/src/components/GanttChart.tsx`)
- Modify the `Bar` component's DOM structure.
- The base container (which has the `track` border/background) currently has a child div for the completed `percent` that is fully filled.
- Instead, make the inner container a flex row. The first child (left side) should be an empty `div` taking up `width: ${percent}%` (representing the completed portion, which will let the hollow track background show through).
- The second child (right side) should be `flex-1` with the `swatch.fill.className` (solid color), representing the remaining/upcoming work.

## 2. Backend - Schema (`backend/schemas.py`)
- Add `gantt_color_by: str | None = Field(default=None)` to `TaskViewFilters`. This allows the server to properly store and return this setting when a user saves a view.

## 3. Frontend - View Persistence (`desktop/src/lib/views.ts` & `desktop/src/pages/Tasks.tsx`)
- Add `gantt_color_by: string | null` to the `ViewFilters` type.
- Update `NO_ADVANCED_FILTERS` and `NO_FILTERS` to include a `null` default for this new key.
- Update `sameFilters` to check this key for equality.
- Update `filtersFromParams` and `writeFilterParams` to serialize/deserialize it to the `?gantt_color_by=...` URL parameter.
- In `Tasks.tsx` (or `TaskGantt`), ensure `filters` and `onFilters` are passed down to `GanttChart`.
- In `GanttChart.tsx`, accept optional `filters` and `onFilters`. If provided, use `filters.gantt_color_by` as the source of truth for the active color setting instead of pure local state, and call `onFilters` when it changes.
