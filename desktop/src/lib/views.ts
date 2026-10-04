// Shapes of the saved task view endpoints (see TaskView and TaskViewFilters in backend/schemas.py).
export type ViewType = "kanban" | "backlog" | "gantt";

/** `null` means no filter; an empty assignee means unassigned tasks. */
export type ViewFilters = { project_id: number | null; assignee: string | null };

export type TaskView = { id: number; space_id: number; name: string; view_type: ViewType; filters: ViewFilters };

export const VIEW_TYPES: Record<ViewType, string> = { kanban: "Kanban", backlog: "Backlog", gantt: "Gantt" };

export const NO_FILTERS: ViewFilters = { project_id: null, assignee: null };

/** Fired after a view is created, renamed, re-filtered or deleted, so the sidebar and the open view reload. */
export const VIEWS_CHANGED = "copilot:views-changed";

export function viewPath(id: number): string {
  return `/views/${id}`;
}

export function sameFilters(a: ViewFilters, b: ViewFilters): boolean {
  return a.project_id === b.project_id && a.assignee === b.assignee;
}
