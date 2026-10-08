import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type FormEvent, type ReactNode } from "react";
import { NavLink, Navigate, useNavigate, useParams, useSearchParams } from "react-router-dom";

import AdvancedFilters from "../components/AdvancedFilters";
import { OptionPill } from "../components/ColorPicker";
import GanttChart, { type GanttDateChange, type GanttProject } from "../components/GanttChart";
import MultiSelect from "../components/MultiSelect";
import PageHeader from "../components/PageHeader";
import { postStatusComment, useStatusChangePrompt } from "../components/StatusChangeDialog";
import {
  AddTaskButton,
  ColumnPicker,
  customColumn,
  formatCustomValue,
  NewTaskRow,
  newTaskDefaults,
  TITLE_COLUMN,
  useColumns,
  type Column,
  type NewTaskDraft,
} from "../components/TaskTable";
import { formatDay, ME, NEUTRAL_TAG, NoteLink, ProjectTag, Tag, TagPills } from "../components/TriageBoard";
import { getJson, message, sendJson } from "../lib/api";
import { AssigneeSelect, personLabel, PersonBadge, usePeople, type Person } from "../lib/people";
import { colouredOptions } from "../lib/colors";
import { useSpace, type CustomFieldDef } from "../lib/space";
import {
  allowedStatuses,
  announceTaskChange,
  BOARD_COLUMNS,
  boardColumn,
  fromGanttDates,
  isOverdue,
  PRIORITY_LABELS,
  STATUS_LABELS,
  taskQuery,
  updateTaskDates,
  useTaskChanges,
  useTaskPanel,
  type DateChange,
  type ProjectOption,
  type StatusFlow,
  type TaskCreate,
  type TaskItem,
  type TaskPatch,
  type TaskPriority,
  type TaskStatus,
} from "../lib/tasks";
import TaskListView from "./TaskListView";
import {
  filtersFromParams,
  fromSaved,
  NO_FILTERS,
  sameFilters,
  VIEW_TYPES,
  VIEWS_CHANGED,
  viewPath,
  writeFilterParams,
  type TaskView,
  type ViewFilters,
  type ViewType,
} from "../lib/views";

const SUBTITLES: Record<ViewType, string> = {
  kanban: "Tasks from the task database. Drag cards between columns to change their status; click one for its details.",
  backlog: "Every task, earliest due date first. Click a task to open its details, description and comments.",
  gantt: "Tasks with start and due dates, grouped by project.",
  list: "A simple list of tasks. Tick tasks to change their status, assignee or archive them all at once.",
};

/** Changes a task's status, asking first for an optional comment explaining it. */
type OnStatus = (task: TaskItem, status: TaskStatus) => void;

type State = { state: "loading" } | { state: "ok"; tasks: TaskItem[] } | { state: "error"; message: string };

const NO_PROJECT_ID = -1;

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
        setFilters(fromSaved(body.filters));
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
      setFilters(fromSaved(updated.filters));
      window.dispatchEvent(new Event(VIEWS_CHANGED));
    } catch (err: unknown) {
      setSaveError(`Could not save the view: ${message(err)}`);
    } finally {
      setSaving(false);
    }
  }

  if (loadError) return <p className="px-9 py-7 text-[15px] text-text-secondary">Could not load this view ({loadError}).</p>;
  if (!view) return <p className="px-9 py-7 text-[15px] text-text-muted">Loading view…</p>;
  const saved = fromSaved(view.filters);
  const dirty = !sameFilters(filters, saved);

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
            <button type="button" className="btn min-h-8 px-3 text-xs" onClick={() => setFilters(saved)}>
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

/** An unsaved view (`/tasks/:view?project=&assignee=&tag=&cf=…`, see `filtersFromParams`), e.g. the note page's link to the backlog. "Save as view" adds it to the sidebar. */
export function AdHocTasks() {
  const { view = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const { spaceId } = useSpace();
  const navigate = useNavigate();
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const filters = filtersFromParams(params);
  const setFilters = (next: ViewFilters) =>
    setParams(
      () => {
        const query = new URLSearchParams();
        const taskId = params.get("taskId");
        if (taskId) query.set("taskId", taskId);
        return writeFilterParams(query, next);
      },
      { replace: true },
    );

  if (!(view in VIEW_TYPES)) return <Navigate to="/tasks/kanban" replace />;
  const viewType = view as ViewType;

  async function saveAs(projects: ProjectOption[]) {
    // Named after its project when it shows just one.
    const code = filters.project_id.length === 1 ? projects.find((p) => p.id === filters.project_id[0])?.code : undefined;
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
  const people = usePeople(spaceId);
  const [tasks, setTasks] = useState<State>({ state: "loading" });
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [tags, setTags] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  // Archived tasks are put away: only the Backlog and List views offer to show them.
  const [showArchived, setShowArchived] = useState(false);
  const canShowArchived = viewType === "backlog" || viewType === "list";
  const includeArchived = canShowArchived && showArchived;

  const query = taskQuery(spaceId, filters, includeArchived);
  const space = spaces.find((s) => s.id === spaceId);
  const spaceName = space?.name ?? "";
  const flow = space?.status_flow ?? null;
  const customFields = space?.custom_fields_schema ?? [];

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

  /** Optimistic update: show the change at once, roll back if the server refuses it. A status change's `comment`
   * is added to the task's discussion once the change is saved. */
  const patchTask = useCallback(async (task: TaskItem, patch: Omit<TaskPatch, "custom_fields">, comment?: string | null) => {
    const apply = (next: TaskItem) =>
      setTasks((prev) => (prev.state === "ok" ? { ...prev, tasks: prev.tasks.map((t) => (t.id === next.id ? next : t)) } : prev));
    apply({ ...task, ...patch });
    setError(null);
    try {
      await sendJson("PATCH", `/api/tasks/${task.id}`, patch);
    } catch (err: unknown) {
      apply(task);
      setError(`Could not update "${task.title}": ${message(err)}`);
      return;
    }
    try {
      if (comment && patch.status) await postStatusComment(task.id, task.status, patch.status, comment);
    } catch (err: unknown) {
      setError(`Changed the status of "${task.title}" but could not add the comment: ${message(err)}`);
    }
    announceTaskChange({ id: task.id, source: "board" });
    if ("project_id" in patch) setReload((n) => n + 1); // refresh the project code
  }, []);

  /** New dates for several tasks (dragged on the Gantt, or a shifted timeline), shown at once. If saving fails the
   * tasks are reloaded, as some of the changes may have been saved. Rejects on failure so the Gantt can drop its undo. */
  const rescheduleTasks = useCallback(async (changes: DateChange[]) => {
    const byId = new Map(changes.map((c) => [c.id, c]));
    setTasks((prev) =>
      prev.state === "ok"
        ? {
            ...prev,
            tasks: prev.tasks.map((t) => {
              const change = byId.get(t.id);
              if (!change) return t;
              const { id: _id, ...dates } = change;
              return { ...t, ...dates };
            }),
          }
        : prev,
    );
    setError(null);
    try {
      await updateTaskDates(changes);
    } catch (err: unknown) {
      setError(`Could not reschedule ${changes.length === 1 ? "the task" : `the ${changes.length} tasks`}: ${message(err)}`);
      setReload((n) => n + 1);
      throw err;
    }
  }, []);

  const { ask, dialog } = useStatusChangePrompt();
  const changeStatus: OnStatus = useCallback(
    async (task, status) => {
      if (status === task.status) return;
      if (!allowedStatuses(flow, task.status).includes(status)) {
        setError(`The space's status flow doesn't allow "${task.title}" to move from ${STATUS_LABELS[task.status]} to ${STATUS_LABELS[status]}.`);
        return;
      }
      const answer = await ask(task, status, flow);
      if (answer) await patchTask(task, { status }, answer.comment);
    },
    [flow, ask, patchTask],
  );

  // Edited in the task panel: show its copy (the next load re-applies the filters).
  useTaskChanges("board", ({ id, task, deleted }) =>
    setTasks((prev) => {
      if (prev.state !== "ok") return prev;
      if (deleted) return { ...prev, tasks: prev.tasks.filter((t) => t.id !== id) };
      return task ? { ...prev, tasks: prev.tasks.map((t) => (t.id === id ? task : t)) } : prev;
    }),
  );

  // The app's user: the person marked "me" on the People page, else the default name.
  const me = people.find((p) => p.is_me)?.name ?? ME;
  const assignees = useMemo(() => {
    const names = new Set<string>([me, ...people.map((p) => p.name)]);
    if (tasks.state === "ok") tasks.tasks.forEach((t) => t.assignee && names.add(t.assignee));
    filters.assignee.forEach((name) => name && names.add(name));
    return [...names].sort((a, b) => Number(b === me) - Number(a === me) || a.localeCompare(b));
  }, [tasks, filters.assignee, people, me]);

  // A saved filter can point at a project this space no longer lists.
  const projectChoices = [
    ...projects,
    ...filters.project_id
      .filter((id) => !projects.some((p) => p.id === id))
      .map((id) => ({ id, code: `#${id}`, name: `#${id}`, color: null, folder_path: null })),
  ];
  // Likewise a tag that no task carries any more.
  const tagChoices = filters.tag === null || tags.includes(filters.tag) ? tags : [...tags, filters.tag];
  // A task archived since the last load (e.g. in the task panel) leaves at once, unless the status filter asks for them.
  const keepArchived = includeArchived || filters.status.includes("archived");
  const newTask = newTaskDefaults(filters, customFields, viewType === "kanban" ? "todo" : "backlog");
  const addTask = (task: TaskItem) =>
    setTasks((prev) => (prev.state === "ok" ? { ...prev, tasks: [...prev.tasks, task] } : prev));
  const visible =
    tasks.state === "ok" ? (keepArchived ? tasks.tasks : tasks.tasks.filter((t) => t.status !== "archived")) : null;

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
          <div role="group" aria-label="Project" className="flex items-center gap-1.5">
            Project
            <MultiSelect
              label="Project"
              anyLabel="All projects"
              options={projectChoices.map((p) => ({ value: p.id, label: p.name !== p.code ? `${p.code} · ${p.name}` : p.code }))}
              value={filters.project_id}
              onChange={(project_id) => onFilters({ ...filters, project_id })}
              className="w-44 py-1.5 text-[15px]"
            />
          </div>
          <div role="group" aria-label="Assignee" className="flex items-center gap-1.5">
            Assignee
            <MultiSelect
              label="Assignee"
              anyLabel="Everyone"
              options={[
                { value: "", label: "Unassigned" },
                ...assignees.map((name) => ({ value: name, label: personLabel({ name, is_me: name === me }) })),
              ]}
              value={filters.assignee}
              onChange={(assignee) => onFilters({ ...filters, assignee })}
              className="w-44 py-1.5 text-[15px]"
            />
          </div>
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
          {canShowArchived && (
            <label className="flex items-center gap-1.5">
              <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
              Show archived
            </label>
          )}
        </div>
      </div>

      <AdvancedFilters filters={filters} customFields={customFields} onFilters={onFilters} />

      {error && <p className="text-[15px] text-accent">{error}</p>}
      {tasks.state === "loading" && <p className="text-[15px] text-text-muted">Loading tasks…</p>}
      {tasks.state === "error" && <p className="text-[15px] text-text-secondary">Could not load the tasks ({tasks.message}).</p>}
      {visible && viewType === "kanban" && (
        <Kanban
          spaceId={spaceId}
          newTaskDefaults={newTask}
          onCreated={addTask}
          tasks={visible}
          flow={flow}
          people={people}
          me={me}
          customFields={customFields}
          onStatus={changeStatus}
        />
      )}
      {visible && viewType === "backlog" && (
        <Backlog
          spaceId={spaceId}
          tasks={visible}
          projects={projects}
          people={people}
          flow={flow}
          customFields={customFields}
          newTask={newTask}
          onCreated={addTask}
          onPatch={patchTask}
          onStatus={changeStatus}
        />
      )}
      {visible && viewType === "gantt" && (
        <TaskGantt
          tasks={visible}
          projects={projects}
          customFields={customFields}
          filters={filters}
          onFilters={onFilters}
          onReschedule={rescheduleTasks}
        />
      )}
      {visible && viewType === "list" && (
        <TaskListView
          spaceId={spaceId}
          tasks={visible}
          flow={flow}
          projects={projects}
          customFields={customFields}
          newTask={newTask}
          onCreated={addTask}
          onUpdated={() => setReload((n) => n + 1)}
        />
      )}
      {dialog}
    </div>
  );
}

// --- Kanban -----------------------------------------------------------------------

const DRAG_TYPE = "application/x-copilot-task";

type OnPatch = (task: TaskItem, patch: Omit<TaskPatch, "custom_fields">) => void;

type CardProps = { flow: StatusFlow | null; people: Person[]; me: string; customFields: CustomFieldDef[]; onStatus: OnStatus };

function Kanban({
  spaceId,
  newTaskDefaults,
  onCreated,
  tasks,
  ...card
}: {
  spaceId: number;
  /** The new card's fields, from the view's filters; the column sets the status. */
  newTaskDefaults: NewTaskDraft;
  onCreated: (task: TaskItem) => void;
  tasks: TaskItem[];
} & CardProps) {
  const [over, setOver] = useState<TaskStatus | null>(null);
  const byId = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks]);

  function drop(event: DragEvent, status: TaskStatus) {
    event.preventDefault();
    setOver(null);
    const task = byId.get(Number(event.dataTransfer.getData(DRAG_TYPE)));
    if (task && boardColumn(task.status) !== status) card.onStatus(task, status);
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
                <KanbanCard key={task.id} task={task} {...card} />
              ))}
            </ul>
            {(status === "todo" || status === "in_progress") && (
              <KanbanAddCard status={status} spaceId={spaceId} defaults={newTaskDefaults} onCreated={onCreated} />
            )}
          </section>
        );
      })}
    </div>
  );
}

/**
 * The "+ Add task" footer of a Kanban column: Enter adds a task to the column and leaves the input open for the
 * next one; Escape, or leaving it empty, closes it.
 */
function KanbanAddCard({
  status,
  spaceId,
  defaults,
  onCreated,
}: {
  status: TaskStatus;
  spaceId: number;
  defaults: NewTaskDraft;
  onCreated: (task: TaskItem) => void;
}) {
  const [isEditing, setIsEditing] = useState(false);
  const [title, setTitle] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  // Disabling the input while saving drops its focus: take it back for the next task.
  useEffect(() => {
    if (isEditing && !saving) input.current?.focus();
  }, [isEditing, saving]);

  function close() {
    setIsEditing(false);
    setTitle("");
    setError(null);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!title.trim() || saving) return;
    setSaving(true);
    setError(null);
    try {
      const body: TaskCreate = { ...defaults, space_id: spaceId, status, title: title.trim() };
      onCreated(await sendJson<TaskItem>("POST", "/api/tasks", body));
      setTitle("");
    } catch (err: unknown) {
      setError(message(err));
    } finally {
      setSaving(false);
    }
  }

  if (!isEditing) {
    return (
      <div className="px-2 pb-2">
        <button
          type="button"
          onClick={() => setIsEditing(true)}
          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] text-text-muted hover:bg-surface-raised hover:text-text-primary"
        >
          <span aria-hidden className="flex h-4 w-4 items-center justify-center rounded border border-border-strong font-mono text-[12px] leading-none">
            +
          </span>
          Add task
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="px-2 pb-2">
      <div className="rounded-md border border-border-default bg-surface-raised p-2">
        <input
          ref={input}
          autoFocus
          aria-label={`New ${STATUS_LABELS[status]} task title`}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => e.key === "Escape" && close()}
          onBlur={() => !title.trim() && !saving && close()}
          disabled={saving}
          placeholder="What needs doing?"
          className="field w-full py-1 text-[13px]"
        />
        {error && <p className="mt-1 text-xs text-accent">{error}</p>}
      </div>
    </form>
  );
}

function KanbanCard({ task, flow, people, me, customFields, onStatus }: { task: TaskItem } & CardProps) {
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
        {task.project_code && <ProjectTag code={task.project_code} color={task.project_color} />}
        {task.status === "blocked" && <Tag className="border-accent bg-accent/15 text-accent">blocked</Tag>}
        {task.is_milestone && <Tag className="border-accent/60 text-accent">milestone</Tag>}
        {colouredOptions(customFields, task.custom_fields).map(({ field }) => (
          <OptionPill key={field.id} field={field} value={task.custom_fields[field.id]} />
        ))}
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
          onChange={(e) => onStatus(task, e.target.value as TaskStatus)}
          className="min-w-0 max-w-[104px] rounded border border-border-default bg-surface-panel px-1 py-0.5 text-[13px] text-text-muted"
        >
          {allowedStatuses(flow, task.status).map((value) => (
            <option key={value} value={value}>
              {STATUS_LABELS[value]}
            </option>
          ))}
        </select>
      </div>
      {task.assignee && (
        <div className="mt-1.5 text-[13px] text-text-muted">
          {(() => {
            const person = people.find((p) => p.name === task.assignee);
            if (person) return <PersonBadge person={person} />;
            return `👤 ${personLabel({ name: task.assignee, is_me: task.assignee === me })}`;
          })()}
        </div>
      )}
    </li>
  );
}

// --- Backlog ----------------------------------------------------------------------

const BACKLOG_COLUMNS: Column[] = [
  { id: TITLE_COLUMN, label: "Task" },
  { id: "project", label: "Project" },
  { id: "status", label: "Status" },
  { id: "assignee", label: "Assignee" },
  { id: "priority", label: "Priority" },
  { id: "start", label: "Start" },
  { id: "due", label: "Due" },
];

// The dates are wide enough for the new task row's date inputs.
const BACKLOG_WIDTHS: Record<string, string> = {
  project: "w-28",
  status: "w-32",
  assignee: "w-32",
  priority: "w-28",
  start: "w-32",
  due: "w-32",
};

function Backlog({
  spaceId,
  tasks,
  projects,
  people,
  flow,
  customFields,
  newTask,
  onCreated,
  onPatch,
  onStatus,
}: {
  spaceId: number;
  tasks: TaskItem[];
  projects: ProjectOption[];
  people: Person[];
  flow: StatusFlow | null;
  customFields: CustomFieldDef[];
  /** The new task row's fields, from the view's filters. */
  newTask: NewTaskDraft;
  onCreated: (task: TaskItem) => void;
  onPatch: OnPatch;
  onStatus: OnStatus;
}) {
  // A task's pill in a note links here with `?taskId=<id>`: show that task even if it's done.
  const { taskId, openTask } = useTaskPanel();
  const [hideDone, setHideDone] = useState(() => !tasks.some((t) => t.id === taskId && t.status === "done"));
  const [adding, setAdding] = useState(false);
  const shown = hideDone ? tasks.filter((t) => t.status !== "done") : tasks;
  const allColumns = [...BACKLOG_COLUMNS, ...customFields.map(customColumn)];
  // Priority and the custom fields are hidden until picked, so the table looks as it did.
  const columns = useColumns("copilot:backlog-columns", allColumns, (id) => id === "priority" || id.startsWith("cf:"));

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-end gap-3 text-xs text-text-muted">
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={hideDone} onChange={(e) => setHideDone(e.target.checked)} />
          Hide done ({tasks.length - tasks.filter((t) => t.status !== "done").length})
        </label>
        <ColumnPicker columns={allColumns} isShown={columns.isShown} onToggle={columns.toggle} />
      </div>
      {shown.length === 0 && !adding && <p className="panel text-center text-sm text-text-muted">No tasks match these filters.</p>}
      <div className="overflow-x-auto rounded-lg border border-border-default bg-surface-raised">
        {(shown.length > 0 || adding) && (
          <table className="w-full min-w-[48rem] table-fixed text-[15px]">
            <thead className="bg-surface-panel text-left text-[13px] uppercase tracking-wider text-text-muted">
              <tr>
                {columns.shown.map((column) => (
                  <th
                    key={column.id}
                    className={`${column.id === TITLE_COLUMN ? "px-4" : `${BACKLOG_WIDTHS[column.id] ?? "w-32"} truncate px-2`} py-2 font-medium`}
                  >
                    {column.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-border-default/60">
              {shown.map((task) => (
                <BacklogRow
                  key={task.id}
                  task={task}
                  columns={columns.shown}
                  projects={projects}
                  people={people}
                  customFields={customFields}
                  active={taskId === task.id}
                  onOpen={() => openTask(task.id)}
                  flow={flow}
                  onPatch={onPatch}
                  onStatus={onStatus}
                />
              ))}
              {adding && (
                <NewTaskRow
                  spaceId={spaceId}
                  columns={columns.shown}
                  fixedLayout
                  defaults={newTask}
                  projects={projects}
                  people={people}
                  customFields={customFields}
                  onCreated={onCreated}
                  onClose={() => setAdding(false)}
                />
              )}
            </tbody>
          </table>
        )}
        {!adding && <AddTaskButton onClick={() => setAdding(true)} />}
      </div>
    </div>
  );
}

function BacklogRow({
  task,
  columns,
  projects,
  people,
  customFields,
  active,
  onOpen,
  flow,
  onPatch,
  onStatus,
}: {
  task: TaskItem;
  columns: Column[];
  projects: ProjectOption[];
  people: Person[];
  customFields: CustomFieldDef[];
  active: boolean;
  onOpen: () => void;
  flow: StatusFlow | null;
  onPatch: OnPatch;
  onStatus: OnStatus;
}) {
  const overdue = isOverdue(task);
  const cell = "rounded border border-transparent bg-transparent px-1 py-0.5 text-[15px] hover:border-border-default focus:border-accent/70 focus:outline-none";
  const projectChoices = projects.some((p) => p.id === task.project_id)
    ? projects
    : task.project_id !== null
      ? [...projects, { id: task.project_id, code: task.project_code ?? `#${task.project_id}`, name: "", color: null, folder_path: null }]
      : projects;

  function render(id: string) {
    switch (id) {
      case TITLE_COLUMN:
        return (
          <td key={id} className="px-4 py-1.5">
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
                {task.status === "archived" && <Tag className={NEUTRAL_TAG}>archived</Tag>}
                <TagPills tags={task.tags} />
              </button>
              {/* Outside the button: a link can't sit inside a button. */}
              {task.note_path && <NoteLink path={task.note_path} />}
            </div>
          </td>
        );
      case "project":
        return (
          <td key={id} className="px-2 py-1.5">
            <select
              aria-label={`Project of ${task.title}`}
              value={task.project_id ?? NO_PROJECT_ID}
              onChange={(e) => {
                const projectId = Number(e.target.value);
                onPatch(task, { project_id: projectId === NO_PROJECT_ID ? null : projectId });
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
        );
      case "status":
        return (
          <td key={id} className="px-2 py-1.5">
            <select
              aria-label={`Status of ${task.title}`}
              value={task.status}
              onChange={(e) => onStatus(task, e.target.value as TaskStatus)}
              className={`${cell} w-full`}
            >
              {allowedStatuses(flow, task.status).map((value) => (
                <option key={value} value={value}>
                  {STATUS_LABELS[value]}
                </option>
              ))}
            </select>
          </td>
        );
      case "assignee":
        return (
          <td key={id} className="px-2 py-1.5">
            <AssigneeSelect
              ariaLabel={`Assignee of ${task.title}`}
              value={task.assignee}
              people={people}
              emptyLabel="—"
              onChange={(assignee) => assignee !== task.assignee && onPatch(task, { assignee })}
              className={`${cell} w-full`}
            />
          </td>
        );
      case "priority":
        return (
          <td key={id} className="px-2 py-1.5">
            <select
              aria-label={`Priority of ${task.title}`}
              value={task.priority}
              onChange={(e) => onPatch(task, { priority: e.target.value as TaskPriority })}
              className={`${cell} w-full`}
            >
              {(Object.keys(PRIORITY_LABELS) as TaskPriority[]).map((value) => (
                <option key={value} value={value}>
                  {PRIORITY_LABELS[value]}
                </option>
              ))}
            </select>
          </td>
        );
      case "start":
        return (
          <td key={id} className="px-2 py-1.5 font-mono text-xs text-text-muted">
            {task.start_date ? formatDay(task.start_date) : "—"}
          </td>
        );
      case "due":
        return (
          <td key={id} className={`px-2 py-1.5 font-mono text-xs ${overdue ? "text-accent" : "text-text-muted"}`}>
            {task.deadline ? formatDay(task.deadline) : "—"}
          </td>
        );
      default: {
        const field = customFields.find((f) => `cf:${f.id}` === id);
        return (
          <td key={id} className="truncate px-2 py-1.5 text-[13px] text-text-muted">
            {field ? formatCustomValue(field, task.custom_fields[field.id]) : "—"}
          </td>
        );
      }
    }
  }

  return (
    <tr className={`${task.status === "done" || task.status === "archived" ? "text-text-muted" : "text-text-secondary"} ${active ? "bg-surface-active" : ""}`}>
      {columns.map((column) => render(column.id))}
    </tr>
  );
}

// --- Gantt ------------------------------------------------------------------------

function TaskGantt({
  tasks,
  projects,
  customFields,
  filters,
  onFilters,
  onReschedule,
}: {
  tasks: TaskItem[];
  projects: ProjectOption[];
  customFields: CustomFieldDef[];
  filters: ViewFilters;
  onFilters: (filters: ViewFilters) => void;
  onReschedule: (changes: DateChange[]) => Promise<void>;
}) {
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
          color: project?.color ?? task.project_color,
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
        custom_fields: task.custom_fields,
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
  return (
    <GanttChart
      projects={groups}
      customFields={customFields}
      colorBy={filters.gantt_color_by}
      onColorBy={(gantt_color_by) => onFilters({ ...filters, gantt_color_by })}
      activeTaskId={taskId}
      onTaskClick={openTask}
      onReschedule={(changes: GanttDateChange[]) => onReschedule(changes.map(fromGanttDates))}
    />
  );
}
