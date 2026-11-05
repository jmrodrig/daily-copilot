import { useEffect, useMemo, useRef, useState } from "react";

import BulkEditDialog from "../components/BulkEditDialog";
import {
  AddTaskButton,
  ariaSort,
  ColumnPicker,
  customColumn,
  formatCustomValue,
  NewTaskRow,
  SortHeader,
  sortTasks,
  TITLE_COLUMN,
  useColumns,
  type Column,
  type NewTaskDraft,
  type Sort,
} from "../components/TaskTable";
import { formatDay, NEUTRAL_TAG, NoteLink, ProjectTag, Tag, TagPills } from "../components/TriageBoard";
import { optionColor, tint } from "../lib/colors";
import { message } from "../lib/api";
import { AvatarCluster, PersonBadge, usePeople, type Person } from "../lib/people";
import { type CustomFieldDef } from "../lib/space";
import {
  allowedStatuses,
  bulkUpdateTasks,
  isOverdue,
  PRIORITY_LABELS,
  STATUS_LABELS,
  taskAssignees,
  useTaskPanel,
  type ProjectOption,
  type StatusFlow,
  type TaskItem,
  type TaskPatch,
} from "../lib/tasks";

/** Every word of the filter must appear in the task's title, project, status, assignee, tags or custom field values. */
function matches(task: TaskItem, words: string[]): boolean {
  if (words.length === 0) return true;
  const text = [
    task.title,
    task.project_code,
    STATUS_LABELS[task.status],
    ...taskAssignees(task),
    ...task.tags.map((tag) => `#${tag}`),
    ...Object.values(task.custom_fields).map(String),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return words.every((word) => text.includes(word));
}

const LIST_COLUMNS: Column[] = [
  { id: TITLE_COLUMN, label: "Task" },
  { id: "project", label: "Project" },
  { id: "status", label: "Status" },
  { id: "assignee", label: "Assignee" },
  { id: "priority", label: "Priority" },
  { id: "start", label: "Start" },
  { id: "due", label: "Due" },
  { id: "tags", label: "Tags" },
];

const LIST_WIDTHS: Record<string, string> = {
  tags: "w-40",
  project: "w-28",
  status: "w-32",
  assignee: "w-32",
  priority: "w-24",
  start: "w-24",
  due: "w-24",
};

/**
 * The List view: a plain table of tasks with a filter box and a checkbox per row. Ticking tasks shows a toolbar that
 * edits any of their fields, or archives them, in one go (`POST /api/tasks/bulk-update`). "Columns" picks the columns
 * shown, and "Add task" adds a row at the bottom for a new task.
 */
export default function TaskListView({
  spaceId,
  tasks,
  flow,
  projects,
  customFields,
  newTask,
  onCreated,
  onUpdated,
}: {
  spaceId: number;
  tasks: TaskItem[];
  flow: StatusFlow | null;
  projects: ProjectOption[];
  customFields: CustomFieldDef[];
  /** The new task row's fields, from the view's filters. */
  newTask: NewTaskDraft;
  onCreated: (task: TaskItem) => void;
  /** Called after a bulk update, so the view reloads its tasks. */
  onUpdated: () => void;
}) {
  const { taskId, openTask } = useTaskPanel();
  const people = usePeople(spaceId);
  const me = people.find((p) => p.is_me)?.name;
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const allColumns = [...LIST_COLUMNS, ...customFields.map(customColumn)];
  // Priority, Start and Tags are hidden until picked, so the table looks as it did.
  const columns = useColumns("copilot:list-columns", allColumns, (id) => id === "priority" || id === "start" || id === "tags");
  // Clicking a column's header sorts by it; null keeps the view's order (earliest due date first).
  const [sort, setSort] = useState<Sort>(null);

  const words = filter.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = useMemo(() => sortTasks(tasks.filter((t) => matches(t, words)), sort, customFields), [tasks, filter, sort, customFields]);

  // Tasks that left the list (archived, deleted, filtered out by the view) can't stay ticked.
  useEffect(() => {
    const ids = new Set(shown.map((t) => t.id));
    setSelected((prev) => {
      const next = new Set([...prev].filter((id) => ids.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [shown]);

  const chosen = shown.filter((t) => selected.has(t.id));
  const allShownSelected = shown.length > 0 && chosen.length === shown.length;

  function toggle(id: number) {
    setNotice(null);
    setSelected((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }

  function toggleAll() {
    setNotice(null);
    setSelected(allShownSelected ? new Set() : new Set(shown.map((t) => t.id)));
  }

  async function apply(updates: TaskPatch, what: string) {
    if (chosen.length === 0 || busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const changed = await bulkUpdateTasks(
        chosen.map((t) => t.id),
        updates,
      );
      setSelected(new Set());
      setNotice(`${what}: ${changed.length} task${changed.length === 1 ? "" : "s"}.`);
      onUpdated();
    } catch (err: unknown) {
      setError(`Could not update the tasks: ${message(err)}`);
    } finally {
      setBusy(false);
    }
  }

  /** Change one task's dropdown field from its cell (`null` clears it). */
  async function setField(task: TaskItem, field: CustomFieldDef, value: string | null) {
    if (busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await bulkUpdateTasks([task.id], { custom_fields: { [field.id]: value } });
      onUpdated();
    } catch (err: unknown) {
      setError(`Could not change ${field.name} of "${task.title}": ${message(err)}`);
    } finally {
      setBusy(false);
    }
  }

  function cell(task: TaskItem, id: string) {
    const finished = task.status === "done" || task.status === "archived";
    const active = taskId === task.id;
    switch (id) {
      case TITLE_COLUMN:
        return (
          <td key={id} className="px-2 py-1.5">
            <div className="flex min-w-0 items-center gap-2">
              <button
                type="button"
                onClick={() => !active && openTask(task.id)}
                title="Open task details"
                aria-current={active || undefined}
                className="flex min-w-0 flex-1 items-center gap-2 text-left"
              >
                <span className={`truncate hover:underline ${finished ? "line-through" : "text-text-primary"}`}>{task.title}</span>
                <TagPills tags={task.tags} />
              </button>
              {task.note_path && <NoteLink path={task.note_path} />}
            </div>
          </td>
        );
      case "project":
        return (
          <td key={id} className="px-2 py-1.5 font-mono text-xs">
            {task.project_code ? <ProjectTag code={task.project_code} color={task.project_color} /> : "—"}
          </td>
        );
      case "status":
        return (
          <td key={id} className="px-2 py-1.5">
            {task.status === "archived" || task.status === "blocked" ? (
              <Tag className={task.status === "blocked" ? "border-accent bg-accent/15 text-accent" : NEUTRAL_TAG}>{STATUS_LABELS[task.status]}</Tag>
            ) : (
              STATUS_LABELS[task.status]
            )}
          </td>
        );
      case "assignee":
        return (
          <td key={id} className="max-w-[16rem] px-2 py-1.5">
            {taskAssignees(task).length > 0 ? <AvatarCluster names={taskAssignees(task)} people={people} me={me} withName /> : "—"}
          </td>
        );
      case "priority":
        return (
          <td key={id} className={`px-2 py-1.5 ${task.priority === "urgent" ? "text-accent" : ""}`}>
            {PRIORITY_LABELS[task.priority]}
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
          <td key={id} className={`px-2 py-1.5 font-mono text-xs ${isOverdue(task) ? "text-accent" : "text-text-muted"}`}>
            {task.deadline ? formatDay(task.deadline) : "—"}
          </td>
        );
      case "tags":
        return (
          <td key={id} className="px-2 py-1.5">
            <div className="flex flex-wrap items-center gap-1">{task.tags.length > 0 ? <TagPills tags={task.tags} /> : "—"}</div>
          </td>
        );
      default: {
        const field = customFields.find((f) => `cf:${f.id}` === id);
        if (!field) return <td key={id} />;
        return (
          <td key={id} className="whitespace-nowrap px-2 py-1.5 text-text-muted">
            {field.type === "dropdown" ? (
              <DropdownCell field={field} task={task} disabled={busy} onChange={(value) => setField(task, field, value)} />
            ) : (
              (() => {
                // A person field shows the person's avatar when they're in People.
                const value = task.custom_fields[field.id];
                const person = field.type === "person" ? people.find((p) => p.name === value) : undefined;
                return person ? <PersonBadge person={person} /> : formatCustomValue(field, value);
              })()
            )}
          </td>
        );
      }
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="search"
          aria-label="Filter tasks"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter by title, project, status, assignee, #tag…"
          className="field max-w-md py-1.5 text-[15px]"
        />
        <span className="font-mono text-[13px] text-text-muted">
          {shown.length === tasks.length ? `${tasks.length} tasks` : `${shown.length} of ${tasks.length} tasks`}
        </span>
        {notice && (
          <span role="status" className="text-xs text-text-secondary">
            {notice}
          </span>
        )}
        <div className="ml-auto">
          <ColumnPicker columns={allColumns} isShown={columns.isShown} onToggle={columns.toggle} />
        </div>
      </div>

      {chosen.length > 0 && (
        <BulkToolbar
          tasks={chosen}
          flow={flow}
          people={people}
          customFields={customFields}
          busy={busy}
          onApply={apply}
          onClear={() => setSelected(new Set())}
        />
      )}
      {error && <p className="text-[15px] text-accent">{error}</p>}

      {shown.length === 0 && !adding && (
        <p className="panel text-center text-sm text-text-muted">No tasks match {tasks.length ? "this filter" : "these filters"}.</p>
      )}
      <div className="overflow-x-auto rounded-lg border border-border-default bg-surface-raised">
        {(shown.length > 0 || adding) && (
          <table className="w-full text-[15px]">
            <thead className="bg-surface-panel text-left text-[13px] uppercase tracking-wider text-text-muted">
              <tr>
                <th className="w-10 px-3 py-2">
                  <SelectAll checked={allShownSelected} indeterminate={chosen.length > 0 && !allShownSelected} onChange={toggleAll} />
                </th>
                {columns.shown.map((column) => (
                  <th
                    key={column.id}
                    aria-sort={ariaSort(sort, column.id)}
                    className={`${LIST_WIDTHS[column.id] ?? ""} whitespace-nowrap px-2 py-2 font-medium`}
                  >
                    <SortHeader column={column} sort={sort} onSort={setSort} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-border-default/60">
              {shown.map((task) => {
                const active = taskId === task.id;
                const finished = task.status === "done" || task.status === "archived";
                return (
                  <tr
                    key={task.id}
                    className={`${finished ? "text-text-muted" : "text-text-secondary"} ${active ? "bg-surface-active" : selected.has(task.id) ? "bg-accent/[0.06]" : ""}`}
                  >
                    <td className="px-3 py-1.5">
                      <input type="checkbox" aria-label={`Select ${task.title}`} checked={selected.has(task.id)} onChange={() => toggle(task.id)} />
                    </td>
                    {columns.shown.map((column) => cell(task, column.id))}
                  </tr>
                );
              })}
              {adding && (
                <NewTaskRow
                  spaceId={spaceId}
                  columns={columns.shown}
                  leadingCells={1}
                  defaults={newTask}
                  projects={projects}
                  people={people}
                  customFields={customFields}
                  onCreated={(task) => {
                    onCreated(task);
                    // Straight into its details, to fill them in.
                    openTask(task.id);
                  }}
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

/** A dropdown custom field, changed right in the table. A value whose option was removed stays shown until changed. */
function DropdownCell({
  field,
  task,
  disabled,
  onChange,
}: {
  field: CustomFieldDef;
  task: TaskItem;
  disabled: boolean;
  onChange: (value: string | null) => void;
}) {
  const value = task.custom_fields[field.id];
  const current = typeof value === "string" ? value : "";
  const color = optionColor(field, current);
  return (
    <select
      aria-label={`${field.name} of ${task.title}`}
      value={current}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value || null)}
      // A coloured option shows as a pill in its colour.
      style={color ? { borderColor: tint(color, 0.6), color, backgroundColor: tint(color, 0.12) } : undefined}
      className={`field w-auto py-0.5 text-[13px] ${current ? "text-text-primary" : "text-text-muted"}`}
    >
      <option value="">—</option>
      {field.options.map((option) => (
        <option key={option} value={option}>
          {option}
        </option>
      ))}
      {current && !field.options.includes(current) && <option value={current}>{current}</option>}
    </select>
  );
}

function SelectAll({ checked, indeterminate, onChange }: { checked: boolean; indeterminate: boolean; onChange: () => void }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate;
  }, [indeterminate]);
  return <input ref={ref} type="checkbox" aria-label="Select all shown tasks" checked={checked} onChange={onChange} />;
}

/**
 * Actions for the ticked tasks: "Bulk edit…" opens a dialog that changes any of their fields, and "Archive" archives
 * them when the space's status flow allows it for every one.
 */
function BulkToolbar({
  tasks,
  flow,
  people,
  customFields,
  busy,
  onApply,
  onClear,
}: {
  tasks: TaskItem[];
  flow: StatusFlow | null;
  people: Person[];
  customFields: CustomFieldDef[];
  busy: boolean;
  onApply: (updates: TaskPatch, what: string) => void;
  onClear: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const archivable = tasks.every((t) => allowedStatuses(flow, t.status).includes("archived"));
  const canArchive = archivable && tasks.some((t) => t.status !== "archived");

  return (
    <div
      role="toolbar"
      aria-label="Bulk actions"
      className="flex flex-wrap items-center gap-2 rounded-lg border border-accent/50 bg-accent/[0.08] px-3 py-2 text-xs text-text-secondary"
    >
      <span className="font-semibold text-text-primary">{tasks.length} selected</span>
      <button type="button" className="btn-primary min-h-7 px-2.5 text-xs" disabled={busy} onClick={() => setEditing(true)}>
        Bulk edit…
      </button>
      <button
        type="button"
        className="btn min-h-7 px-2.5 text-xs"
        disabled={busy || !canArchive}
        title={archivable ? undefined : "The space's status flow doesn't allow archiving every selected task"}
        onClick={() => onApply({ status: "archived" }, "Archived")}
      >
        Archive
      </button>
      <button type="button" className="ml-auto text-text-muted hover:text-text-primary" onClick={onClear}>
        Clear selection
      </button>
      {busy && <span className="text-text-muted">Saving…</span>}
      {editing && (
        <BulkEditDialog
          tasks={tasks}
          flow={flow}
          people={people}
          customFields={customFields}
          onApply={onApply}
          onClose={() => setEditing(false)}
        />
      )}
    </div>
  );
}
