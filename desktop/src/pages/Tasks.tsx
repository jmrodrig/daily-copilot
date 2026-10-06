import { useCallback, useEffect, useMemo, useState, type DragEvent, type FormEvent, type ReactNode } from "react";
import { NavLink, Navigate, useNavigate, useParams, useSearchParams } from "react-router-dom";

import GanttChart, { type GanttProject } from "../components/GanttChart";
import PageHeader from "../components/PageHeader";
import { formatDay, ME, NEUTRAL_TAG, NoteLink, PROJECT_TAG, Tag, TagPills } from "../components/TriageBoard";
import { getJson, message, sendJson } from "../lib/api";
import { useSpace } from "../lib/space";
import {
  announceTaskChange,
  BOARD_COLUMNS,
  boardColumn,
  isOverdue,
  STATUS_LABELS,
  taskQuery,
  useTaskChanges,
  useTaskPanel,
  type ProjectOption,
  type TaskItem,
  type TaskPatch,
  type TaskStatus,
} from "../lib/tasks";
import {
  NO_FILTERS,
  sameFilters,
  VIEW_TYPES,
  VIEWS_CHANGED,
  viewPath,
  type TaskView,
  type ViewFilters,
  type ViewType,
} from "../lib/views";

const SUBTITLES: Record<ViewType, string> = {
  kanban: "Tasks from the task database. Drag cards between columns to change their status; click one for its details.",
  backlog: "Every task, earliest due date first. Click a task to open its details, description and comments.",
  gantt: "Tasks with start and due dates, grouped by project.",
};

type State = { state: "loading" } | { state: "ok"; tasks: TaskItem[] } | { state: "error"; message: string };

const NO_PROJECT_ID = -1;

function projectTag(code: string | null): string {
  return (code && PROJECT_TAG[code.toLowerCase()]) || NEUTRAL_TAG;
}

/** A saved view (`/views/:id`) from the sidebar. Changed filters apply at once; "Save view" keeps them. */
export default function SavedTaskView() {
  const { id = "" } = useParams();
  const [view, setView] = useState<TaskView | null>(null);
  const [filters, setFilters] = useState<ViewFilters>(NO_FILTERS);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const fetchView = () => getJson<TaskView>(`/api/views/${id}`, controller.signal);
    const failed = (err: unknown) => {
      if (!controller.signal.aborted) setLoadError(message(err));
    };
    setView(null);
    setLoadError(null);
    setSaveError(null);
    fetchView()
      .then((body) => {
        setView(body);
        setFilters(body.filters);
      })
      .catch(failed);
    // Renamed from the sidebar: refresh the saved view but keep any unsaved filters.
    const reload = () => fetchView().then(setView).catch(failed);
    window.addEventListener(VIEWS_CHANGED, reload);
    return () => {
      window.removeEventListener(VIEWS_CHANGED, reload);
      controller.abort();
    };
  }, [id]);

  async function save() {
    if (!view) return;
    setSaving(true);
    setSaveError(null);
    try {
      const updated = await sendJson<TaskView>("PUT", `/api/views/${view.id}`, { filters });
      setView(updated);
      setFilters(updated.filters);
      window.dispatchEvent(new Event(VIEWS_CHANGED));
    } catch (err: unknown) {
      setSaveError(`Could not save the view: ${message(err)}`);
    } finally {
      setSaving(false);
    }
  }

  if (loadError) return <p className="px-9 py-7 text-[15px] text-text-secondary">Could not load this view ({loadError}).</p>;
  if (!view) return <p className="px-9 py-7 text-[15px] text-text-muted">Loading view…</p>;
  const dirty = !sameFilters(filters, view.filters);

  return (
    <TaskBoard
      spaceId={view.space_id}
      viewType={view.view_type}
      title={view.name}
      filters={filters}
      onFilters={setFilters}
      actions={() => (
        <>
          {saveError && <span className="text-xs text-accent">{saveError}</span>}
          {dirty && (
            <button type="button" className="btn min-h-8 px-3 text-xs" onClick={() => setFilters(view.filters)}>
              Revert
            </button>
          )}
          <button type="button" className="btn-primary min-h-8 px-3 text-xs" disabled={!dirty || saving} onClick={save}>
            {saving ? "Saving…" : dirty ? "Save view" : "Saved"}
          </button>
        </>
      )}
    />
  );
}

/** An unsaved view (`/tasks/:view?project=&assignee=&tag=`), e.g. the note page's link to the backlog. "Save as view" adds it to the sidebar. */
export function AdHocTasks() {
  const { view = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const { spaceId } = useSpace();
  const navigate = useNavigate();
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const project = Number(params.get("project") ?? "");
  const filters: ViewFilters = {
    project_id: params.get("project") && Number.isInteger(project) ? project : null,
    assignee: params.get("assignee"),
    tag: params.get("tag") || null,
  };
  const setFilters = (next: ViewFilters) =>
    setParams(
      () => {
        const query = new URLSearchParams();
        const taskId = params.get("taskId");
        if (taskId) query.set("taskId", taskId);
        if (next.project_id !== null) query.set("project", String(next.project_id));
        if (next.assignee !== null) query.set("assignee", next.assignee);
        if (next.tag !== null) query.set("tag", next.tag);
        return query;
      },
      { replace: true },
    );

  if (!(view in VIEW_TYPES)) return <Navigate to="/tasks/kanban" replace />;
  const viewType = view as ViewType;

  async function saveAs(projects: ProjectOption[]) {
    const code = projects.find((p) => p.id === filters.project_id)?.code;
    setSaving(true);
    setSaveError(null);
    try {
      const created = await sendJson<TaskView>("POST", "/api/views", {
        space_id: spaceId,
        name: code ? `${code} ${VIEW_TYPES[viewType]}` : VIEW_TYPES[viewType],
        view_type: viewType,
        filters,
      });
      window.dispatchEvent(new Event(VIEWS_CHANGED));
      navigate(viewPath(created.id));
    } catch (err: unknown) {
      setSaveError(`Could not save the view: ${message(err)}`);
      setSaving(false);
    }
  }

  return (
    <TaskBoard
      spaceId={spaceId}
      viewType={viewType}
      title={VIEW_TYPES[viewType]}
      filters={filters}
      onFilters={setFilters}
      nav={
        <nav aria-label="Task views" className="flex gap-2">
          {(Object.keys(VIEW_TYPES) as ViewType[]).map((key) => (
            <NavLink key={key} to={{ pathname: `/tasks/${key}`, search: params.toString() }} className={key === viewType ? "seg-on" : "seg"}>
              <span className="flex h-full items-center">{VIEW_TYPES[key]}</span>
            </NavLink>
          ))}
        </nav>
      }
      actions={(projects) => (
        <>
          {saveError && <span className="text-xs text-accent">{saveError}</span>}
          <button type="button" className="btn min-h-8 px-3 text-xs" disabled={saving} onClick={() => saveAs(projects)}>
            {saving ? "Saving…" : "Save as view"}
          </button>
        </>
      )}
    />
  );
}

/** A space's tasks from the database as a Kanban, Backlog or Gantt, narrowed by the Project/Assignee/Tag filters. */
function TaskBoard({
  spaceId,
  viewType,
  title,
  filters,
  onFilters,
  nav,
  actions,
}: {
  spaceId: number;
  viewType: ViewType;
  title: string;
  filters: ViewFilters;
  onFilters: (filters: ViewFilters) => void;
  nav?: ReactNode;
  actions?: (projects: ProjectOption[]) => ReactNode;
}) {
  const { spaces } = useSpace();
  const [tasks, setTasks] = useState<State>({ state: "loading" });
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [tags, setTags] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  const query = taskQuery(spaceId, filters);
  const spaceName = spaces.find((s) => s.id === spaceId)?.name ?? "";

  useEffect(() => {
    const controller = new AbortController();
    setTasks((prev) => (prev.state === "ok" ? prev : { state: "loading" }));
    getJson<TaskItem[]>(`/api/tasks?${query}`, controller.signal)
      .then((body) => setTasks({ state: "ok", tasks: body }))
      .catch((err: unknown) => {
        if (!controller.signal.aborted) setTasks({ state: "error", message: message(err) });
      });
    return () => controller.abort();
  }, [query, reload]);

  useEffect(() => {
    const controller = new AbortController();
    getJson<ProjectOption[]>(`/api/projects?space_id=${spaceId}`, controller.signal)
      .then(setProjects)
      .catch(() => {});
    return () => controller.abort();
  }, [spaceId]);

  useEffect(() => {
    const controller = new AbortController();
    getJson<string[]>(`/api/spaces/${spaceId}/tags`, controller.signal)
      .then(setTags)
      .catch(() => {});
    return () => controller.abort();
  }, [spaceId, reload]);

  /** Optimistic update: show the change at once, roll back if the server refuses it. */
  const patchTask = useCallback(async (task: TaskItem, patch: TaskPatch) => {
    const apply = (next: TaskItem) =>
      setTasks((prev) => (prev.state === "ok" ? { ...prev, tasks: prev.tasks.map((t) => (t.id === next.id ? next : t)) } : prev));
    apply({ ...task, ...patch });
    setError(null);
    try {
      await sendJson("PATCH", `/api/tasks/${task.id}`, patch);
      announceTaskChange({ id: task.id, source: "board" });
      if ("project_id" in patch) setReload((n) => n + 1); // refresh the project code
    } catch (err: unknown) {
      apply(task);
      setError(`Could not update "${task.title}": ${message(err)}`);
    }
  }, []);

  // Edited in the task panel: show its copy (the next load re-applies the filters).
  useTaskChanges("board", ({ id, task, deleted }) =>
    setTasks((prev) => {
      if (prev.state !== "ok") return prev;
      if (deleted) return { ...prev, tasks: prev.tasks.filter((t) => t.id !== id) };
      return task ? { ...prev, tasks: prev.tasks.map((t) => (t.id === id ? task : t)) } : prev;
    }),
  );

  const assignees = useMemo(() => {
    const names = new Set<string>([ME]);
    if (tasks.state === "ok") tasks.tasks.forEach((t) => t.assignee && names.add(t.assignee));
    if (filters.assignee) names.add(filters.assignee);
    return [...names].sort((a, b) => a.localeCompare(b));
  }, [tasks, filters.assignee]);

  // A saved filter can point at a project this space no longer lists.
  const projectChoices =
    filters.project_id === null || projects.some((p) => p.id === filters.project_id)
      ? projects
      : [...projects, { id: filters.project_id, code: `#${filters.project_id}`, name: `#${filters.project_id}`, folder_path: null }];
  // Likewise a tag that no task carries any more.
  const tagChoices = filters.tag === null || tags.includes(filters.tag) ? tags : [...tags, filters.tag];

  return (
    <div className="flex flex-col gap-5 px-9 py-7">
      <PageHeader
        eyebrow={`${spaceName.toUpperCase()} · ${VIEW_TYPES[viewType].toUpperCase()} VIEW`}
        title={title}
        subtitle={SUBTITLES[viewType]}
        actions={actions && <div className="flex flex-wrap items-center gap-2">{actions(projects)}</div>}
      />

      <div className="flex flex-wrap items-center justify-between gap-3">
        {nav ?? <span />}
        <div className="flex flex-wrap items-center gap-2 text-xs text-text-muted">
          <label className="flex items-center gap-1.5">
            Project
            <select
              value={filters.project_id ?? ""}
              onChange={(e) => onFilters({ ...filters, project_id: e.target.value ? Number(e.target.value) : null })}
              className="field w-auto py-1.5 text-[15px]"
            >
              <option value="">All projects</option>
              {projectChoices.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.code}
                  {p.name !== p.code ? ` · ${p.name}` : ""}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-1.5">
            Assignee
            <select
              value={filters.assignee === null ? "*" : filters.assignee}
              onChange={(e) => onFilters({ ...filters, assignee: e.target.value === "*" ? null : e.target.value })}
              className="field w-auto py-1.5 text-[15px]"
            >
              <option value="*">Everyone</option>
              <option value="">Unassigned</option>
              {assignees.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-1.5">
            Tag
            <select
              value={filters.tag ?? ""}
              onChange={(e) => onFilters({ ...filters, tag: e.target.value || null })}
              className="field w-auto py-1.5 text-[15px]"
            >
              <option value="">All tags</option>
              {tagChoices.map((tag) => (
                <option key={tag} value={tag}>
                  #{tag}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>

      <NewTaskForm
        spaceId={spaceId}
        projects={projects}
        defaultProject={filters.project_id === null ? null : String(filters.project_id)}
        defaultStatus={viewType === "kanban" ? "todo" : "backlog"}
        onCreated={(task) =>
          setTasks((prev) => (prev.state === "ok" ? { ...prev, tasks: [task, ...prev.tasks] } : prev))
        }
      />

      {error && <p className="text-[15px] text-accent">{error}</p>}
      {tasks.state === "loading" && <p className="text-[15px] text-text-muted">Loading tasks…</p>}
      {tasks.state === "error" && <p className="text-[15px] text-text-secondary">Could not load the tasks ({tasks.message}).</p>}
      {tasks.state === "ok" && viewType === "kanban" && <Kanban tasks={tasks.tasks} onPatch={patchTask} />}
      {tasks.state === "ok" && viewType === "backlog" && (
        <Backlog tasks={tasks.tasks} projects={projects} onPatch={patchTask} />
      )}
      {tasks.state === "ok" && viewType === "gantt" && <TaskGantt tasks={tasks.tasks} projects={projects} />}
    </div>
  );
}

// --- New task -------------------------------------------------------------------

function NewTaskForm({
  spaceId,
  projects,
  defaultProject,
  defaultStatus,
  onCreated,
}: {
  spaceId: number;
  projects: ProjectOption[];
  defaultProject: string | null;
  defaultStatus: TaskStatus;
  onCreated: (task: TaskItem) => void;
}) {
  const [title, setTitle] = useState("");
  const [project, setProject] = useState(defaultProject ?? "");
  const [assignee, setAssignee] = useState("");
  const [start, setStart] = useState("");
  const [due, setDue] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setProject(defaultProject ?? ""), [defaultProject]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!title.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const task = await sendJson<TaskItem>("POST", "/api/tasks", {
        space_id: spaceId,
        title: title.trim(),
        project_id: project ? Number(project) : null,
        assignee: assignee.trim() || null,
        start_date: start || null,
        deadline: due || null,
        status: defaultStatus,
      });
      onCreated(task);
      setTitle("");
      setStart("");
      setDue("");
    } catch (err: unknown) {
      setError(message(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-wrap items-end gap-2 rounded-lg border border-border-default bg-surface-raised p-3">
      <label className="flex min-w-[220px] flex-1 flex-col gap-1 text-[13px] text-text-muted">
        New task
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="What needs doing?" className="field py-1.5" />
      </label>
      <label className="flex flex-col gap-1 text-[13px] text-text-muted">
        Project
        <select value={project} onChange={(e) => setProject(e.target.value)} className="field w-36 py-1.5">
          <option value="">No project</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.code}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-[13px] text-text-muted">
        Assignee
        <input value={assignee} onChange={(e) => setAssignee(e.target.value)} placeholder={ME} className="field w-28 py-1.5" />
      </label>
      <label className="flex flex-col gap-1 text-[13px] text-text-muted">
        Start
        <input type="date" value={start} onChange={(e) => setStart(e.target.value)} className="field w-36 py-1.5" />
      </label>
      <label className="flex flex-col gap-1 text-[13px] text-text-muted">
        Due
        <input type="date" value={due} onChange={(e) => setDue(e.target.value)} className="field w-36 py-1.5" />
      </label>
      <button type="submit" className="btn-primary min-h-9" disabled={saving || !title.trim()}>
        {saving ? "Adding…" : `Add to ${STATUS_LABELS[defaultStatus]}`}
      </button>
      {error && <p className="w-full text-xs text-accent">{error}</p>}
    </form>
  );
}

// --- Kanban -----------------------------------------------------------------------

const DRAG_TYPE = "application/x-copilot-task";

function Kanban({ tasks, onPatch }: { tasks: TaskItem[]; onPatch: (task: TaskItem, patch: TaskPatch) => void }) {
  const [over, setOver] = useState<TaskStatus | null>(null);
  const byId = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks]);

  function drop(event: DragEvent, status: TaskStatus) {
    event.preventDefault();
    setOver(null);
    const task = byId.get(Number(event.dataTransfer.getData(DRAG_TYPE)));
    if (task && boardColumn(task.status) !== status) onPatch(task, { status });
  }

  return (
    <div className="grid min-h-[420px] grid-cols-4 gap-3">
      {BOARD_COLUMNS.map(({ status, label }) => {
        const column = tasks.filter((t) => boardColumn(t.status) === status);
        return (
          <section
            key={status}
            aria-label={label}
            onDragOver={(e) => {
              if (e.dataTransfer.types.includes(DRAG_TYPE)) {
                e.preventDefault();
                setOver(status);
              }
            }}
            onDragLeave={() => setOver((prev) => (prev === status ? null : prev))}
            onDrop={(e) => drop(e, status)}
            className={`flex max-h-[calc(100vh-300px)] min-h-0 flex-col rounded-lg border bg-surface-panel ${
              over === status ? "border-accent/70" : "border-border-default"
            }`}
          >
            <h3 className="flex items-center justify-between px-3 py-2 text-xs font-medium uppercase tracking-wider text-text-muted">
              <span>{label}</span>
              <span className="font-mono">{column.length}</span>
            </h3>
            <ul className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-2 pb-2">
              {column.map((task) => (
                <KanbanCard key={task.id} task={task} onPatch={onPatch} />
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

function KanbanCard({ task, onPatch }: { task: TaskItem; onPatch: (task: TaskItem, patch: TaskPatch) => void }) {
  const overdue = isOverdue(task);
  const { taskId, openTask } = useTaskPanel();
  const active = taskId === task.id;
  const open = () => !active && openTask(task.id);
  return (
    <li
      draggable
      tabIndex={0}
      aria-current={active || undefined}
      title="Click for details · drag to change status"
      onDragStart={(e) => {
        e.dataTransfer.setData(DRAG_TYPE, String(task.id));
        e.dataTransfer.effectAllowed = "move";
      }}
      onClick={open}
      onKeyDown={(e) => {
        if ((e.key === "Enter" || e.key === " ") && e.target === e.currentTarget) {
          e.preventDefault();
          open();
        }
      }}
      className={`cursor-grab rounded-md border bg-surface-raised p-2.5 hover:border-border-light focus:outline-none focus-visible:border-accent/70 active:cursor-grabbing ${
        active ? "border-accent/70" : "border-border-default"
      }`}
    >
      <div className="text-[15px] text-text-primary">{task.title}</div>
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        {task.project_code && <Tag className={projectTag(task.project_code)}>{task.project_code}</Tag>}
        {task.status === "blocked" && <Tag className="border-accent bg-accent/15 text-accent">blocked</Tag>}
        {task.is_milestone && <Tag className="border-accent/60 text-accent">milestone</Tag>}
        <TagPills tags={task.tags} />
        {task.note_path && <NoteLink path={task.note_path} />}
      </div>
      <div className="mt-1.5 flex items-center justify-between gap-2 font-mono text-[13px]">
        <span
          className={`whitespace-nowrap ${overdue ? "text-accent" : "text-text-muted"}`}
          title={task.deadline ? `Due ${task.deadline}${overdue ? " (overdue)" : ""}` : undefined}
        >
          {task.deadline ? `${formatDay(task.deadline)}${overdue ? " · late" : ""}` : "No due date"}
        </span>
        {/* Keyboard alternative to dragging. */}
        <select
          aria-label={`Status of ${task.title}`}
          value={task.status}
          // Changing the status shouldn't also open the card.
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => onPatch(task, { status: e.target.value as TaskStatus })}
          className="min-w-0 max-w-[104px] rounded border border-border-default bg-surface-panel px-1 py-0.5 text-[13px] text-text-muted"
        >
          {Object.entries(STATUS_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </div>
      {task.assignee && <div className="mt-1 text-[13px] text-text-muted">👤 {task.assignee}</div>}
    </li>
  );
}

// --- Backlog ----------------------------------------------------------------------

function Backlog({
  tasks,
  projects,
  onPatch,
}: {
  tasks: TaskItem[];
  projects: ProjectOption[];
  onPatch: (task: TaskItem, patch: TaskPatch) => void;
}) {
  // A task's pill in a note links here with `?taskId=<id>`: show that task even if it's done.
  const { taskId, openTask } = useTaskPanel();
  const [hideDone, setHideDone] = useState(() => !tasks.some((t) => t.id === taskId && t.status === "done"));
  const shown = hideDone ? tasks.filter((t) => t.status !== "done") : tasks;

  return (
    <div className="flex flex-col gap-2">
      <label className="flex items-center gap-2 self-end text-xs text-text-muted">
        <input type="checkbox" checked={hideDone} onChange={(e) => setHideDone(e.target.checked)} />
        Hide done ({tasks.length - tasks.filter((t) => t.status !== "done").length})
      </label>
      {shown.length === 0 ? (
        <p className="panel text-center text-sm text-text-muted">No tasks match these filters.</p>
      ) : (
        <div className="overflow-hidden rounded-lg border border-border-default bg-surface-raised">
          <table className="w-full table-fixed text-[15px]">
            <thead className="bg-surface-panel text-left text-[13px] uppercase tracking-wider text-text-muted">
              <tr>
                <th className="px-4 py-2 font-medium">Task</th>
                <th className="w-28 px-2 py-2 font-medium">Project</th>
                <th className="w-32 px-2 py-2 font-medium">Status</th>
                <th className="w-32 px-2 py-2 font-medium">Assignee</th>
                <th className="w-24 px-2 py-2 font-medium">Start</th>
                <th className="w-24 px-2 py-2 font-medium">Due</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border-default/60">
              {shown.map((task) => (
                <BacklogRow
                  key={task.id}
                  task={task}
                  projects={projects}
                  active={taskId === task.id}
                  onOpen={() => openTask(task.id)}
                  onPatch={onPatch}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function BacklogRow({
  task,
  projects,
  active,
  onOpen,
  onPatch,
}: {
  task: TaskItem;
  projects: ProjectOption[];
  active: boolean;
  onOpen: () => void;
  onPatch: (task: TaskItem, patch: TaskPatch) => void;
}) {
  const overdue = isOverdue(task);
  const cell = "rounded border border-transparent bg-transparent px-1 py-0.5 text-[15px] hover:border-border-default focus:border-accent/70 focus:outline-none";
  const projectChoices = projects.some((p) => p.id === task.project_id)
    ? projects
    : task.project_id !== null
      ? [...projects, { id: task.project_id, code: task.project_code ?? `#${task.project_id}`, name: "", folder_path: null }]
      : projects;

  return (
    <tr className={`${task.status === "done" ? "text-text-muted" : "text-text-secondary"} ${active ? "bg-surface-active" : ""}`}>
      <td className="px-4 py-1.5">
        <div className="flex min-w-0 items-center gap-2">
          <button
            type="button"
            onClick={() => !active && onOpen()}
            title="Open task details"
            aria-current={active || undefined}
            className="flex min-w-0 flex-1 items-center gap-2 text-left"
          >
            <span className={`truncate hover:underline ${task.status === "done" ? "line-through" : "text-text-primary"}`}>{task.title}</span>
            {task.is_gantt_task && <Tag className={NEUTRAL_TAG}>gantt</Tag>}
            <TagPills tags={task.tags} />
          </button>
          {/* Outside the button: a link can't sit inside a button. */}
          {task.note_path && <NoteLink path={task.note_path} />}
        </div>
      </td>
      <td className="px-2 py-1.5">
        <select
          aria-label={`Project of ${task.title}`}
          value={task.project_id ?? NO_PROJECT_ID}
          onChange={(e) => {
            const id = Number(e.target.value);
            onPatch(task, { project_id: id === NO_PROJECT_ID ? null : id });
          }}
          className={`${cell} w-full`}
        >
          <option value={NO_PROJECT_ID}>—</option>
          {projectChoices.map((p) => (
            <option key={p.id} value={p.id}>
              {p.code}
            </option>
          ))}
        </select>
      </td>
      <td className="px-2 py-1.5">
        <select
          aria-label={`Status of ${task.title}`}
          value={task.status}
          onChange={(e) => onPatch(task, { status: e.target.value as TaskStatus })}
          className={`${cell} w-full`}
        >
          {Object.entries(STATUS_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </td>
      <td className="px-2 py-1.5">
        <AssigneeInput task={task} className={`${cell} w-full`} onPatch={onPatch} />
      </td>
      <td className="px-2 py-1.5 font-mono text-xs text-text-muted">{task.start_date ? formatDay(task.start_date) : "—"}</td>
      <td className={`px-2 py-1.5 font-mono text-xs ${overdue ? "text-accent" : "text-text-muted"}`}>
        {task.deadline ? formatDay(task.deadline) : "—"}
      </td>
    </tr>
  );
}

/** Free-text assignee, saved on blur or Enter. */
function AssigneeInput({
  task,
  className,
  onPatch,
}: {
  task: TaskItem;
  className: string;
  onPatch: (task: TaskItem, patch: TaskPatch) => void;
}) {
  const [value, setValue] = useState(task.assignee ?? "");
  useEffect(() => setValue(task.assignee ?? ""), [task.assignee]);
  const save = () => {
    const next = value.trim() || null;
    if (next !== task.assignee) onPatch(task, { assignee: next });
  };
  return (
    <input
      aria-label={`Assignee of ${task.title}`}
      value={value}
      placeholder="—"
      onChange={(e) => setValue(e.target.value)}
      onBlur={save}
      onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
      className={className}
    />
  );
}

// --- Gantt ------------------------------------------------------------------------

function TaskGantt({ tasks, projects }: { tasks: TaskItem[]; projects: ProjectOption[] }) {
  const groups = useMemo(() => {
    const byProject = new Map<number, GanttProject>();
    for (const task of tasks) {
      const id = task.project_id ?? 0;
      if (!byProject.has(id)) {
        const project = projects.find((p) => p.id === id);
        byProject.set(id, {
          id,
          code: task.project_code ?? "No project",
          name: project?.name ?? task.project_code ?? "No project",
          tasks: [],
        });
      }
      byProject.get(id)!.tasks.push({
        id: task.id,
        name: task.title,
        start_date: task.start_date,
        end_date: task.deadline,
        completion_percent: task.completion_percent,
        status: task.status,
        is_milestone: task.is_milestone,
      });
    }
    const byStart = (a: { start_date: string | null }, b: { start_date: string | null }) =>
      (a.start_date ?? "9999").localeCompare(b.start_date ?? "9999");
    return [...byProject.values()]
      .map((group) => ({ ...group, tasks: group.tasks.sort(byStart) }))
      .sort((a, b) => (a.id === 0 ? 1 : b.id === 0 ? -1 : a.code.localeCompare(b.code)));
  }, [tasks, projects]);

  const { taskId, openTask } = useTaskPanel();
  if (groups.length === 0) return <p className="panel text-center text-sm text-text-muted">No tasks match these filters.</p>;
  return <GanttChart projects={groups} activeTaskId={taskId} onTaskClick={openTask} />;
}
