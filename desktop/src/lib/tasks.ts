import { useCallback, useEffect, useRef } from "react";
import { useSearchParams } from "react-router-dom";

import type { ViewFilters } from "./views";

// Shapes of the task engine endpoints (see TaskItem, ProjectOption etc. in backend/schemas.py).
export type TaskStatus = "backlog" | "todo" | "in_progress" | "blocked" | "done";
export type TaskPriority = "low" | "normal" | "high" | "urgent";

export type TaskItem = {
  id: number;
  space_id: number;
  project_id: number | null;
  project_code: string | null;
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
};

/** Body of `POST /api/tasks`. */
export type TaskCreate = Partial<Omit<TaskPatch, "project_id">> & { space_id: number; title: string; project_id?: number | null };

export type ProjectOption = { id: number; code: string; name: string; folder_path: string | null };

/** Fields of `PATCH /api/tasks/{id}`; the response is the plain task row. */
export type TaskPatch = Partial<
  Pick<TaskItem, "title" | "description" | "status" | "priority" | "assignee" | "project_id" | "start_date" | "deadline" | "tags" | "note_path">
>;

/** The Kanban columns, left to right. Blocked tasks sit in "In progress" with a tag. */
export const BOARD_COLUMNS: { status: TaskStatus; label: string }[] = [
  { status: "backlog", label: "Backlog" },
  { status: "todo", label: "To do" },
  { status: "in_progress", label: "In progress" },
  { status: "done", label: "Done" },
];

export const STATUS_LABELS: Record<TaskStatus, string> = {
  backlog: "Backlog",
  todo: "To do",
  in_progress: "In progress",
  blocked: "Blocked",
  done: "Done",
};

export function boardColumn(status: TaskStatus): TaskStatus {
  return status === "blocked" ? "in_progress" : status;
}

const MS_PER_DAY = 86_400_000;

export function isOverdue(task: TaskItem): boolean {
  if (!task.deadline || task.status === "done" || task.completion_percent >= 100) return false;
  const now = new Date();
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) / MS_PER_DAY;
  const [y, m, d] = task.deadline.split("-").map(Number);
  return Date.UTC(y, m - 1, d) / MS_PER_DAY < today;
}

/** Query string for `GET /api/tasks` and the task views: the space plus a view's Project/Assignee filters. */
export function taskQuery(spaceId: number, filters: ViewFilters): string {
  const params = new URLSearchParams({ space_id: String(spaceId) });
  if (filters.project_id !== null) params.set("project_id", String(filters.project_id));
  // An empty assignee asks for unassigned tasks.
  if (filters.assignee !== null) params.set("assignee", filters.assignee);
  if (filters.tag !== null) params.set("tag", filters.tag);
  return params.toString();
}

/** One comment in a task's discussion (see TaskComment in backend/schemas.py). */
export type TaskComment = { id: string; author: string | null; text: string; created_at: string; updated_at: string | null };

/** Fired after a task changes, so the views and the task panel stay in step. `task` is the new copy, when the sender has it. */
export const TASK_CHANGED = "copilot:task-changed";
export type TaskChange = { id: number; source: "board" | "panel"; task?: TaskItem; deleted?: boolean };

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
