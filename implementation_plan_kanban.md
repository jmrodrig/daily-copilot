# Implementation Plan: Remove Banner & Add Kanban Inline Task Creation

## Goal
Remove the large "New task" banner from the Gantt and Kanban views. Instead, add a discrete "+ Add task" button at the bottom of the "Todo" and "In progress" columns in the Kanban view that allows quick inline task creation prepopulated with the view's current filters.

## Branch
Use branch `feat/kanban-add-task`

## 1. Remove NewTaskForm from Gantt and Kanban
**File:** `desktop/src/pages/Tasks.tsx`
- **Issue:** The `NewTaskForm` component is rendered at the top of the Gantt and Kanban views, taking up vertical space (as indicated by the red X in the user's screenshot).
- **Fix:** In the `TaskBoard` component, find the conditional render `{(viewType === "kanban" || viewType === "gantt") && <NewTaskForm ... />}` and remove it completely so the banner no longer appears for these views.

## 2. Pass Creation Props to Kanban
**File:** `desktop/src/pages/Tasks.tsx`
- **Fix:** Update the `Kanban` component invocation in `TaskBoard` to receive the necessary props to create tasks:
  ```tsx
  <Kanban 
    spaceId={spaceId}
    newTaskDefaults={newTask}
    onCreated={addTask}
    tasks={visible} 
    ... 
  />
  ```
- Update `Kanban`'s props signature to accept `spaceId: number`, `newTaskDefaults: NewTaskDraft`, and `onCreated: (task: TaskItem) => void`.

## 3. Implement Inline Kanban Task Creation
**File:** `desktop/src/pages/Tasks.tsx` (in the `Kanban` component)
- **Fix:** 
  1. Underneath the `<ul ...>{column.map(...)}</ul>` for each column, conditionally check if the column is "Todo" or "In progress" (`status === "todo" || status === "in_progress"`).
  2. If true, render a new component `<KanbanAddCard status={status} spaceId={spaceId} defaults={newTaskDefaults} onCreated={onCreated} />` (you will create this component in this file).
  3. **KanbanAddCard Component:**
     - Should have a state `[isEditing, setIsEditing]` and `[title, setTitle]`.
     - When not editing, show a subtle "+ Add task" button that looks like a normal Kanban card but faded, or just a small ghost button matching the column footer style.
     - When editing, show an inline text `<input>` inside a card-like container with placeholder "What needs doing?".
     - Auto-focus the input when it appears (using `autoFocus` or a ref).
     - On `onSubmit` (pressing Enter), submit to the backend: `sendJson("POST", "/api/tasks", { ...defaults, status, title: title.trim() })`.
     - While saving, disable the input. Once created, call `onCreated`, clear the title, and keep the input open so the user can quickly add another task.
     - Handle `onBlur`: if the title is empty, set `isEditing` to false to close it. If it has text, maybe let it stay or save it (closing if empty is standard).
