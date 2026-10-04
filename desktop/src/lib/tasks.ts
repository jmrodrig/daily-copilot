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
  note_paths: string[];
};

export type ProjectOption = { id: number; code: string; name: string; folder_path: string | null };

/** Fields of `PATCH /api/tasks/{id}`; the response is the plain task row. */
export type TaskPatch = Partial<
  Pick<TaskItem, "title" | "description" | "status" | "priority" | "assignee" | "project_id" | "start_date" | "deadline">
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

/** Query string for `GET /api/tasks` and the task views: the space plus the Project/Assignee filters. */
export function taskQuery(spaceId: number, filters: { project: string | null; assignee: string | null }): string {
  const params = new URLSearchParams({ space_id: String(spaceId) });
  if (filters.project) params.set("project_id", filters.project);
  // An empty assignee asks for unassigned tasks.
  if (filters.assignee !== null) params.set("assignee", filters.assignee);
  return params.toString();
}
