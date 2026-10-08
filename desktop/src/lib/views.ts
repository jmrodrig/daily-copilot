import type { TaskPriority, TaskStatus } from "./tasks";

// Shapes of the saved task view endpoints (see TaskView and TaskViewFilters in backend/schemas.py).
export type ViewType = "kanban" | "backlog" | "gantt" | "list";

/**
 * A task view's filters. `null` means no filter; so does an empty list for the multi-select ones (`project_id`,
 * `assignee`, `priority`, `status`), which match tasks with any of the values picked. An empty assignee means
 * unassigned tasks.
 *
 * The advanced ones: `custom_fields` maps a field id to the value to match ("" for tasks without a value, "*" for
 * tasks with any; see `_custom_field_matches` in backend/main.py), `has_deadline` / `has_start_date` ask for tasks with
 * (true) or without (false) that date, `due_after` / `due_before` and `start_after` / `start_before` ("YYYY-MM-DD") bound
 * the due and start dates, inclusive, `priority` / `status` ask for any of those picked, and `is_gantt_task` / `is_milestone` /
 * `has_note` ask for tasks that are (true) or aren't (false) Gantt tasks, milestones, or linked to a note.
 *
 * `gantt_color_by` isn't a filter but how the Gantt colours its bars (a dropdown field id; `null` for by project), kept
 * with the filters so a saved view and the URL remember it.
 */
export type ViewFilters = {
  project_id: number[];
  assignee: string[];
  tag: string | null;
  custom_fields: Record<string, string>;
  has_deadline: boolean | null;
  has_start_date: boolean | null;
  due_after: string | null;
  due_before: string | null;
  priority: TaskPriority[];
  status: TaskStatus[];
  is_gantt_task: boolean | null;
  is_milestone: boolean | null;
  has_note: boolean | null;
  start_after: string | null;
  start_before: string | null;
  gantt_color_by: string | null;
};

export type TaskView = { id: number; space_id: number; name: string; view_type: ViewType; filters: SavedFilters };

export const VIEW_TYPES: Record<ViewType, string> = { kanban: "Kanban", backlog: "Backlog", gantt: "Gantt", list: "List" };

/** The advanced filters besides the custom fields and the lists: each is off when `null`, and sent to the server under its own name. */
export const ADVANCED_FILTER_KEYS = [
  "has_deadline",
  "has_start_date",
  "due_after",
  "due_before",
  "is_gantt_task",
  "is_milestone",
  "has_note",
  "start_after",
  "start_before",
] as const;

/** The advanced multi-select filters: off when empty, and sent to the server as one param per value. */
export const ADVANCED_LIST_KEYS = ["priority", "status"] as const;

type AdvancedFilterKey = (typeof ADVANCED_FILTER_KEYS)[number] | (typeof ADVANCED_LIST_KEYS)[number];

export const NO_ADVANCED_FILTERS: Pick<ViewFilters, "custom_fields" | AdvancedFilterKey> = {
  custom_fields: {},
  has_deadline: null,
  has_start_date: null,
  due_after: null,
  due_before: null,
  priority: [],
  status: [],
  is_gantt_task: null,
  is_milestone: null,
  has_note: null,
  start_after: null,
  start_before: null,
};

// `gantt_color_by` is left out of NO_ADVANCED_FILTERS, so clearing the advanced filters keeps the Gantt colours.
export const NO_FILTERS: ViewFilters = { project_id: [], assignee: [], tag: null, ...NO_ADVANCED_FILTERS, gantt_color_by: null };

/** Filters as the server sends them, where a multi-select filter that is off is `null`. */
export type SavedFilters = Omit<ViewFilters, "project_id" | "assignee" | "priority" | "status"> & {
  project_id: number[] | null;
  assignee: string[] | null;
  priority: TaskPriority[] | null;
  status: TaskStatus[] | null;
};

/** A saved view's filters, with the multi-select filters that are off as empty lists. */
export function fromSaved(filters: SavedFilters): ViewFilters {
  return {
    ...filters,
    project_id: filters.project_id ?? [],
    assignee: filters.assignee ?? [],
    priority: filters.priority ?? [],
    status: filters.status ?? [],
  };
}

/** Fired after a view is created, renamed, re-filtered or deleted, so the sidebar and the open view reload. */
export const VIEWS_CHANGED = "copilot:views-changed";

export function viewPath(id: number): string {
  return `/views/${id}`;
}

/** How many advanced filters are set (for the collapsed section's summary). */
export function advancedFilterCount(filters: ViewFilters): number {
  return (
    Object.keys(filters.custom_fields).length +
    ADVANCED_FILTER_KEYS.filter((key) => filters[key] !== null).length +
    ADVANCED_LIST_KEYS.filter((key) => filters[key].length > 0).length
  );
}

function sameCustomFields(a: Record<string, string>, b: Record<string, string>): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => key in b && a[key] === b[key]);
}

/** The same values picked, in any order. */
function sameValues<T>(a: readonly T[], b: readonly T[]): boolean {
  const set = new Set(a);
  return set.size === new Set(b).size && b.every((value) => set.has(value));
}

export function sameFilters(a: ViewFilters, b: ViewFilters): boolean {
  return (
    sameValues(a.project_id, b.project_id) &&
    sameValues(a.assignee, b.assignee) &&
    a.tag === b.tag &&
    a.gantt_color_by === b.gantt_color_by &&
    sameCustomFields(a.custom_fields, b.custom_fields) &&
    ADVANCED_FILTER_KEYS.every((key) => a[key] === b[key]) &&
    ADVANCED_LIST_KEYS.every((key) => sameValues<string>(a[key], b[key]))
  );
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

// Kept here rather than imported, as tasks.ts imports this module.
const PRIORITIES: readonly TaskPriority[] = ["low", "normal", "high", "urgent"];
const STATUSES: readonly TaskStatus[] = ["backlog", "todo", "in_progress", "blocked", "done", "archived"];

function flag(value: string | null): boolean | null {
  return value === "true" ? true : value === "false" ? false : null;
}

/** The values among `choices`, without repeats. */
function someOf<T extends string>(choices: readonly T[], values: string[]): T[] {
  return choices.filter((choice) => values.includes(choice));
}

/**
 * The filters of an unsaved view from its URL (`/tasks/:view?project=&assignee=&tag=&cf=<field id>:<value>&has_deadline=
 * &has_start_date=&due_after=&due_before=&priority=&status=&is_gantt_task=&is_milestone=&has_note=&start_after=&start_before=&gantt_color_by=`), so a filtered view can be bookmarked or shared.
 * `project`, `assignee`, `priority` and `status` can be repeated.
 */
export function filtersFromParams(params: URLSearchParams): ViewFilters {
  const projects = params
    .getAll("project")
    .filter(Boolean)
    .map(Number)
    .filter((id) => Number.isInteger(id));
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
    project_id: [...new Set(projects)],
    assignee: [...new Set(params.getAll("assignee"))],
    tag: params.get("tag") || null,
    custom_fields,
    has_deadline: flag(params.get("has_deadline")),
    has_start_date: flag(params.get("has_start_date")),
    due_after: day("due_after"),
    due_before: day("due_before"),
    priority: someOf(PRIORITIES, params.getAll("priority")),
    status: someOf(STATUSES, params.getAll("status")),
    is_gantt_task: flag(params.get("is_gantt_task")),
    is_milestone: flag(params.get("is_milestone")),
    has_note: flag(params.get("has_note")),
    start_after: day("start_after"),
    start_before: day("start_before"),
    gantt_color_by: params.get("gantt_color_by") || null,
  };
}

/** `filters` as the URL params read by `filtersFromParams`, added to `params`. */
export function writeFilterParams(params: URLSearchParams, filters: ViewFilters): URLSearchParams {
  for (const id of filters.project_id) params.append("project", String(id));
  for (const name of filters.assignee) params.append("assignee", name);
  if (filters.tag !== null) params.set("tag", filters.tag);
  if (filters.gantt_color_by !== null) params.set("gantt_color_by", filters.gantt_color_by);
  for (const [id, value] of Object.entries(filters.custom_fields)) params.append("cf", `${id}:${value}`);
  writeAdvancedParams(params, filters);
  return params;
}

/** The advanced filters besides the custom fields, added to `params` (the URL and the server use the same names). */
export function writeAdvancedParams(params: URLSearchParams, filters: ViewFilters): URLSearchParams {
  for (const key of ADVANCED_FILTER_KEYS) {
    const value = filters[key];
    if (value !== null) params.set(key, String(value));
  }
  for (const key of ADVANCED_LIST_KEYS) for (const value of filters[key]) params.append(key, value);
  return params;
}
