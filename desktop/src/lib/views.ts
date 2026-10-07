// Shapes of the saved task view endpoints (see TaskView and TaskViewFilters in backend/schemas.py).
export type ViewType = "kanban" | "backlog" | "gantt" | "list";

/**
 * A task view's filters. `null` means no filter; an empty assignee means unassigned tasks.
 *
 * The advanced ones: `custom_fields` maps a field id to the value to match ("" for tasks without a value, "*" for
 * tasks with any; see `_custom_field_matches` in backend/main.py), `has_deadline` / `has_start_date` ask for tasks with
 * (true) or without (false) that date, and `due_after` / `due_before` ("YYYY-MM-DD") bound the due date, inclusive.
 */
export type ViewFilters = {
  project_id: number | null;
  assignee: string | null;
  tag: string | null;
  custom_fields: Record<string, string>;
  has_deadline: boolean | null;
  has_start_date: boolean | null;
  due_after: string | null;
  due_before: string | null;
};

export type TaskView = { id: number; space_id: number; name: string; view_type: ViewType; filters: ViewFilters };

export const VIEW_TYPES: Record<ViewType, string> = { kanban: "Kanban", backlog: "Backlog", gantt: "Gantt", list: "List" };

export const NO_ADVANCED_FILTERS: Pick<ViewFilters, "custom_fields" | "has_deadline" | "has_start_date" | "due_after" | "due_before"> = {
  custom_fields: {},
  has_deadline: null,
  has_start_date: null,
  due_after: null,
  due_before: null,
};

export const NO_FILTERS: ViewFilters = { project_id: null, assignee: null, tag: null, ...NO_ADVANCED_FILTERS };

/** Fired after a view is created, renamed, re-filtered or deleted, so the sidebar and the open view reload. */
export const VIEWS_CHANGED = "copilot:views-changed";

export function viewPath(id: number): string {
  return `/views/${id}`;
}

/** How many advanced filters are set (for the collapsed section's summary). */
export function advancedFilterCount(filters: ViewFilters): number {
  return (
    Object.keys(filters.custom_fields).length +
    [filters.has_deadline, filters.has_start_date, filters.due_after, filters.due_before].filter((f) => f !== null).length
  );
}

function sameCustomFields(a: Record<string, string>, b: Record<string, string>): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => key in b && a[key] === b[key]);
}

export function sameFilters(a: ViewFilters, b: ViewFilters): boolean {
  return (
    a.project_id === b.project_id &&
    a.assignee === b.assignee &&
    a.tag === b.tag &&
    sameCustomFields(a.custom_fields, b.custom_fields) &&
    a.has_deadline === b.has_deadline &&
    a.has_start_date === b.has_start_date &&
    a.due_after === b.due_after &&
    a.due_before === b.due_before
  );
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

function flag(value: string | null): boolean | null {
  return value === "true" ? true : value === "false" ? false : null;
}

/**
 * The filters of an unsaved view from its URL (`/tasks/:view?project=&assignee=&tag=&cf=<field id>:<value>&has_deadline=
 * &has_start_date=&due_after=&due_before=`), so a filtered view can be bookmarked or shared.
 */
export function filtersFromParams(params: URLSearchParams): ViewFilters {
  const project = Number(params.get("project") ?? "");
  const custom_fields: Record<string, string> = {};
  for (const param of params.getAll("cf")) {
    const at = param.indexOf(":");
    if (at > 0) custom_fields[param.slice(0, at)] = param.slice(at + 1);
  }
  const day = (key: string) => {
    const value = params.get(key);
    return value && DAY.test(value) ? value : null;
  };
  return {
    project_id: params.get("project") && Number.isInteger(project) ? project : null,
    assignee: params.get("assignee"),
    tag: params.get("tag") || null,
    custom_fields,
    has_deadline: flag(params.get("has_deadline")),
    has_start_date: flag(params.get("has_start_date")),
    due_after: day("due_after"),
    due_before: day("due_before"),
  };
}

/** `filters` as the URL params read by `filtersFromParams`, added to `params`. */
export function writeFilterParams(params: URLSearchParams, filters: ViewFilters): URLSearchParams {
  if (filters.project_id !== null) params.set("project", String(filters.project_id));
  if (filters.assignee !== null) params.set("assignee", filters.assignee);
  if (filters.tag !== null) params.set("tag", filters.tag);
  for (const [id, value] of Object.entries(filters.custom_fields)) params.append("cf", `${id}:${value}`);
  if (filters.has_deadline !== null) params.set("has_deadline", String(filters.has_deadline));
  if (filters.has_start_date !== null) params.set("has_start_date", String(filters.has_start_date));
  if (filters.due_after !== null) params.set("due_after", filters.due_after);
  if (filters.due_before !== null) params.set("due_before", filters.due_before);
  return params;
}
