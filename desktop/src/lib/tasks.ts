import { useCallback, useEffect, useRef } from "react";
import { useSearchParams } from "react-router-dom";

import { sendJson } from "./api";
import { writeAdvancedParams, type ViewFilters } from "./views";

// Shapes of the task engine endpoints (see TaskItem, ProjectOption etc. in backend/schemas.py).
export type TaskStatus = "backlog" | "todo" | "in_progress" | "blocked" | "done" | "archived";
export type TaskPriority = "low" | "normal" | "high" | "urgent";

export type TaskItem = {
  id: number;
  space_id: number;
  project_id: number | null;
  project_code: string | null;
  /** The project's "#rrggbb" colour, if set. */
  project_color: string | null;
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  assignee: string | null;
  start_date: string | null;
  deadline: string | null;
  completion_percent: number;
  is_gantt_task: boolean;
  is_milestone: boolean;
  tags: string[];
  /** The note the task links to (relative to the space's content/); a note can have many tasks. */
  note_path: string | null;
  /** Oldest first. */
  comments: TaskComment[];
  /** Values of the space's custom fields by field id (see CustomFieldDef in ./space). */
  custom_fields: Record<string, CustomFieldValue>;
};

export type CustomFieldValue = string | number | boolean;

/** Body of `POST /api/tasks`. */
export type TaskCreate = Partial<Omit<TaskPatch, "project_id">> & { space_id: number; title: string; project_id?: number | null };

export type ProjectOption = { id: number; code: string; name: string; color: string | null; folder_path: string | null };

/** Body of `PUT /api/projects/{id}`; `color: null` goes back to the default swatch. */
export type ProjectUpdate = { name?: string; description?: string; color?: string | null };

/** Fields of `PATCH /api/tasks/{id}` and of a bulk update's `updates`; the PATCH response is the plain task row. */
export type TaskPatch = Partial<
  Pick<
    TaskItem,
    | "title"
    | "description"
    | "status"
    | "priority"
    | "assignee"
    | "project_id"
    | "start_date"
    | "deadline"
    | "tags"
    | "note_path"
    | "is_gantt_task"
    | "is_milestone"
  >
> & {
  /** Merged into the task's custom fields; `null` clears a field. */
  custom_fields?: Record<string, CustomFieldValue | null>;
};

/** The Kanban columns, left to right. Blocked tasks sit in "In progress" with a tag. */
export const BOARD_COLUMNS: { status: TaskStatus; label: string }[] = [
  { status: "todo", label: "To do" },
  { status: "blocked", label: "Blocked" },
  { status: "in_progress", label: "In progress" },
  { status: "done", label: "Done" },
];

export const STATUS_LABELS: Record<TaskStatus, string> = {
  backlog: "Backlog",
  todo: "To do",
  in_progress: "In progress",
  blocked: "Blocked",
  done: "Done",
  archived: "Archived",
};

export const PRIORITY_LABELS: Record<TaskPriority, string> = { low: "Low", normal: "Normal", high: "High", urgent: "Urgent" };

/** Every status, in workflow order. */
export const STATUSES = Object.keys(STATUS_LABELS) as TaskStatus[];

/**
 * Status -> the statuses a task may move to next -> whether that move asks for a comment (see StatusFlow in
 * backend/schemas.py). `null` allows every move without asking.
 */
export type StatusFlow = Partial<Record<TaskStatus, Partial<Record<TaskStatus, boolean>>>>;

/**
 * The statuses a task in `current` may move to under a space's status flow, `current` included, in workflow order.
 * A status the flow doesn't mention is unrestricted.
 */
export function allowedStatuses(flow: StatusFlow | null | undefined, current: TaskStatus): TaskStatus[] {
  const targets = flow?.[current];
  if (!targets) return STATUSES;
  return STATUSES.filter((s) => s === current || s in targets);
}

/** Whether the space's status flow asks for a comment when a task moves from `from` to `to`. */
export function commentRequested(flow: StatusFlow | null | undefined, from: TaskStatus, to: TaskStatus): boolean {
  return from !== to && flow?.[from]?.[to] === true;
}

/** The text of the comment left when a status change is explained (see StatusChangeDialog). */
export function statusChangeComment(from: TaskStatus, to: TaskStatus, comment: string): string {
  return `Status: ${STATUS_LABELS[from]} → ${STATUS_LABELS[to]}\n\n${comment.trim()}`;
}

export function boardColumn(status: TaskStatus): TaskStatus {
  return status;
}

const MS_PER_DAY = 86_400_000;

export function isOverdue(task: TaskItem): boolean {
  if (!task.deadline || task.status === "done" || task.completion_percent >= 100) return false;
  const now = new Date();
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) / MS_PER_DAY;
  const [y, m, d] = task.deadline.split("-").map(Number);
  return Date.UTC(y, m - 1, d) / MS_PER_DAY < today;
}

/**
 * Query string for `GET /api/tasks` and the task views: the space plus a view's filters, advanced ones included.
 * Archived tasks are left out unless `includeArchived`.
 */
export function taskQuery(spaceId: number, filters: ViewFilters, includeArchived = false): string {
  const params = new URLSearchParams({ space_id: String(spaceId) });
  if (includeArchived) params.set("include_archived", "true");
  if (filters.project_id !== null) params.set("project_id", String(filters.project_id));
  // An empty assignee asks for unassigned tasks.
  if (filters.assignee !== null) params.set("assignee", filters.assignee);
  if (filters.tag !== null) params.set("tag", filters.tag);
  for (const [id, value] of Object.entries(filters.custom_fields)) params.append("cf", `${id}:${value}`);
  writeAdvancedParams(params, filters);
  return params.toString();
}

/** One comment in a task's discussion (see TaskComment in backend/schemas.py). */
export type TaskComment = { id: string; author: string | null; text: string; created_at: string; updated_at: string | null };

/** Fired after a task changes, so the views and the task panel stay in step. `task` is the new copy, when the sender has it. */
export const TASK_CHANGED = "copilot:task-changed";
export type TaskChange = { id: number; source: "board" | "panel"; task?: TaskItem; deleted?: boolean };

/** `POST /api/tasks/bulk-update`: the same change to several tasks (all or nothing); answers with the changed tasks. */
export async function bulkUpdateTasks(taskIds: number[], updates: TaskPatch): Promise<TaskItem[]> {
  const tasks = await sendJson<TaskItem[]>("POST", "/api/tasks/bulk-update", { task_ids: taskIds, updates });
  tasks.forEach((task) => announceTaskChange({ id: task.id, task, source: "board" }));
  return tasks;
}

/** A task's new dates, e.g. after dragging it on the Gantt; a field left out is left as it is. */
export type DateChange = { id: number; start_date?: string | null; deadline?: string | null };

/** A Gantt chart's date change as a task's: the chart's `end_date` is the task's `deadline`. */
export function fromGanttDates({ id, start_date, end_date }: { id: number; start_date?: string | null; end_date?: string | null }): DateChange {
  const change: DateChange = { id };
  if (start_date !== undefined) change.start_date = start_date;
  if (end_date !== undefined) change.deadline = end_date;
  return change;
}

/**
 * Saves different dates for several tasks with `POST /api/tasks/bulk-update`: tasks getting the same dates share one
 * request. Each request is all or nothing, but the requests are separate, so a failure can leave some tasks changed.
 */
export async function updateTaskDates(changes: DateChange[]): Promise<TaskItem[]> {
  const groups = new Map<string, { ids: number[]; updates: TaskPatch }>();
  for (const { id, ...updates } of changes) {
    const key = JSON.stringify([updates.start_date, updates.deadline, "start_date" in updates, "deadline" in updates]);
    const group = groups.get(key) ?? { ids: [] as number[], updates };
    group.ids.push(id);
    groups.set(key, group);
  }
  const results = await Promise.all([...groups.values()].map(({ ids, updates }) => bulkUpdateTasks(ids, updates)));
  return results.flat();
}

export function announceTaskChange(change: TaskChange) {
  window.dispatchEvent(new CustomEvent<TaskChange>(TASK_CHANGED, { detail: change }));
}

/** Calls `listener` for task changes from anyone but `source`. */
export function useTaskChanges(source: TaskChange["source"], listener: (change: TaskChange) => void) {
  const latest = useRef(listener);
  latest.current = listener;
  useEffect(() => {
    const handle = (event: Event) => {
      const change = (event as CustomEvent<TaskChange>).detail;
      if (change.source !== source) latest.current(change);
    };
    window.addEventListener(TASK_CHANGED, handle);
    return () => window.removeEventListener(TASK_CHANGED, handle);
  }, [source]);
}

// The task open in the right-hand panel is the `?taskId=` of the current page, so it survives a reload and Back closes it.
const TASK_PARAM = "taskId";

export function useTaskPanel() {
  const [params, setParams] = useSearchParams();
  const taskId = Number(params.get(TASK_PARAM)) || null;
  const openTask = useCallback(
    (id: number) =>
      setParams((prev) => {
        const next = new URLSearchParams(prev);
        next.set(TASK_PARAM, String(id));
        return next;
      }),
    [setParams],
  );
  const closeTask = useCallback(
    () =>
      setParams((prev) => {
        const next = new URLSearchParams(prev);
        next.delete(TASK_PARAM);
        return next;
      }),
    [setParams],
  );
  return { taskId, openTask, closeTask };
}

/** The task a pill's href points to: `/tasks/backlog?taskId=12`, or `?task=12` in notes saved before the panel. */
export function taskIdFromHref(href: string): number | null {
  const params = new URL(href, window.location.origin).searchParams;
  return Number(params.get(TASK_PARAM) ?? params.get("task")) || null;
}
