# Implementation Plan: Task Pill Status & Customizable Colors

## Goal
Show the status of tasks inside inline task pills within notes. Implement standard status colors and allow users to customize them per-space in Space Preferences.

## Branch
Use branch `feat/task-pill-status`

## 1. Backend Schema Updates
**File:** `backend/schemas.py`
- Update `SpaceUpdate` to include `status_colors: dict[Status, str] | None = None`.
- Update `Space` to include `status_colors: dict[Status, str] = Field(default_factory=dict)`.

## 2. Frontend Schema & Defaults
**File:** `desktop/src/lib/space.tsx`
- Add `status_colors: Record<string, string>` to `Space`.
- Add `status_colors?: Record<string, string>` to `SpaceUpdate`.
**File:** `desktop/src/lib/tasks.ts`
- Export a `DEFAULT_STATUS_COLORS` dictionary mapping each `TaskStatus` to a pleasant default hex color (e.g. green for done, red for blocked, slate for backlog, blue for in_progress).

## 3. Space Preferences UI
**File:** `desktop/src/pages/SpacePreferences.tsx`
- Add a "Status Colors" section (e.g. below Custom Fields or Status Flow).
- Iterate through the statuses, providing a native `<input type="color">` for each.
- The UI should read from `space.status_colors[status] ?? DEFAULT_STATUS_COLORS[status]`.
- Updating a color should call `updateSpace` with the merged `status_colors` dictionary.

## 4. Render Status on Task Pills
**File:** `desktop/src/components/referencePill.tsx`
- In `PillView`, introduce a local `[status, setStatus]` state.
- Add a `useEffect` that calls `getJson<TaskItem>("/api/tasks/" + taskId)` on mount to fetch the real-time status.
- Update the existing `TASK_CHANGED` listener to also update `status` if `change.task.status` is present.
- Render a small colored dot indicator (`w-2 h-2 rounded-full inline-block mr-1`) before the task name. Look up the color using `useSpace().space.status_colors[status] ?? DEFAULT_STATUS_COLORS[status]`.
**File:** `desktop/src/pages/NotePage.tsx`
- Do the exact same for `TaskPillLink`: fetch the task status on mount and render the colored dot next to the PillIcon or in front of the children.
