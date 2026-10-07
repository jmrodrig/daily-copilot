import { useEffect, useMemo, useRef, useState } from "react";

import { formatDay, NEUTRAL_TAG, NoteLink, ProjectTag, Tag, TagPills } from "../components/TriageBoard";
import { optionColor, tint } from "../lib/colors";
import { message } from "../lib/api";
import { byName, personLabel, PersonBadge, usePeople, type Person } from "../lib/people";
import { useSpace, type CustomFieldDef } from "../lib/space";
import {
  allowedStatuses,
  bulkUpdateTasks,
  isOverdue,
  STATUS_LABELS,
  STATUSES,
  useTaskPanel,
  type CustomFieldValue,
  type StatusFlow,
  type TaskItem,
  type TaskPatch,
  type TaskStatus,
} from "../lib/tasks";

/** Every word of the filter must appear in the task's title, project, status, assignee, tags or custom field values. */
function matches(task: TaskItem, words: string[]): boolean {
  if (words.length === 0) return true;
  const text = [
    task.title,
    task.project_code,
    STATUS_LABELS[task.status],
    task.assignee,
    ...task.tags.map((tag) => `#${tag}`),
    ...Object.values(task.custom_fields).map(String),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return words.every((word) => text.includes(word));
}

function formatValue(field: CustomFieldDef, value: CustomFieldValue | undefined): string {
  if (value === undefined) return "—";
  if (field.type === "checkbox") return value ? "✓" : "—";
  if (field.type === "date" && typeof value === "string") return formatDay(value);
  return String(value);
}

/**
 * The List view: a plain table of tasks with a filter box and a checkbox per row. Ticking tasks shows a toolbar that
 * changes their status or assignee, or archives them, in one go (`POST /api/tasks/bulk-update`).
 */
export default function TaskListView({
  tasks,
  flow,
  customFields,
  onUpdated,
}: {
  tasks: TaskItem[];
  flow: StatusFlow | null;
  customFields: CustomFieldDef[];
  /** Called after a bulk update, so the view reloads its tasks. */
  onUpdated: () => void;
}) {
  const { taskId, openTask } = useTaskPanel();
  const people = usePeople(useSpace().spaceId);
  const me = people.find((p) => p.is_me)?.name;
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const words = filter.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = useMemo(() => tasks.filter((t) => matches(t, words)), [tasks, filter]);

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
      </div>

      {chosen.length > 0 && (
        <BulkToolbar tasks={chosen} flow={flow} people={people} busy={busy} onApply={apply} onClear={() => setSelected(new Set())} />
      )}
      {error && <p className="text-[15px] text-accent">{error}</p>}

      {shown.length === 0 ? (
        <p className="panel text-center text-sm text-text-muted">No tasks match {tasks.length ? "this filter" : "these filters"}.</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border-default bg-surface-raised">
          <table className="w-full text-[15px]">
            <thead className="bg-surface-panel text-left text-[13px] uppercase tracking-wider text-text-muted">
              <tr>
                <th className="w-10 px-3 py-2">
                  <SelectAll checked={allShownSelected} indeterminate={chosen.length > 0 && !allShownSelected} onChange={toggleAll} />
                </th>
                <th className="px-2 py-2 font-medium">Task</th>
                <th className="w-28 px-2 py-2 font-medium">Project</th>
                <th className="w-32 px-2 py-2 font-medium">Status</th>
                <th className="w-32 px-2 py-2 font-medium">Assignee</th>
                <th className="w-24 px-2 py-2 font-medium">Due</th>
                {customFields.map((field) => (
                  <th key={field.id} className="whitespace-nowrap px-2 py-2 font-medium">
                    {field.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-border-default/60">
              {shown.map((task) => {
                const active = taskId === task.id;
                const finished = task.status === "done" || task.status === "archived";
                const overdue = isOverdue(task);
                return (
                  <tr
                    key={task.id}
                    className={`${finished ? "text-text-muted" : "text-text-secondary"} ${active ? "bg-surface-active" : selected.has(task.id) ? "bg-accent/[0.06]" : ""}`}
                  >
                    <td className="px-3 py-1.5">
                      <input type="checkbox" aria-label={`Select ${task.title}`} checked={selected.has(task.id)} onChange={() => toggle(task.id)} />
                    </td>
                    <td className="px-2 py-1.5">
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
                    <td className="px-2 py-1.5 font-mono text-xs">{task.project_code ? <ProjectTag code={task.project_code} color={task.project_color} /> : "—"}</td>
                    <td className="px-2 py-1.5">
                      {task.status === "archived" || task.status === "blocked" ? (
                        <Tag className={task.status === "blocked" ? "border-accent bg-accent/15 text-accent" : NEUTRAL_TAG}>{STATUS_LABELS[task.status]}</Tag>
                      ) : (
                        STATUS_LABELS[task.status]
                      )}
                    </td>
                    <td className="truncate px-2 py-1.5">
                      {(() => {
                        if (!task.assignee) return "—";
                        const person = people.find((p) => p.name === task.assignee);
                        if (person) return <PersonBadge person={person} />;
                        return task.assignee === me ? personLabel({ name: task.assignee, is_me: true }) : task.assignee;
                      })()}
                    </td>
                    <td className={`px-2 py-1.5 font-mono text-xs ${overdue ? "text-accent" : "text-text-muted"}`}>
                      {task.deadline ? formatDay(task.deadline) : "—"}
                    </td>
                    {customFields.map((field) => (
                      <td key={field.id} className="whitespace-nowrap px-2 py-1.5 text-text-muted">
                        {field.type === "dropdown" ? (
                          <DropdownCell
                            field={field}
                            task={task}
                            disabled={busy}
                            onChange={(value) => setField(task, field, value)}
                          />
                        ) : (
                          formatValue(field, task.custom_fields[field.id])
                        )}
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
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

// The bulk assignee picker's "Nobody" choice: a value no person's name can be (names are trimmed).
const UNASSIGN = " unassign";

/** Actions for the ticked tasks. Only statuses the space's status flow allows for every one of them are offered. */
function BulkToolbar({
  tasks,
  flow,
  people,
  busy,
  onApply,
  onClear,
}: {
  tasks: TaskItem[];
  flow: StatusFlow | null;
  people: Person[];
  busy: boolean;
  onApply: (updates: TaskPatch, what: string) => void;
  onClear: () => void;
}) {
  const statuses = STATUSES.filter((s) => tasks.every((t) => allowedStatuses(flow, t.status).includes(s)));
  const canArchive = statuses.includes("archived") && tasks.some((t) => t.status !== "archived");
  const assignees = [...people].sort((a, b) => Number(b.is_me) - Number(a.is_me) || byName(a, b));

  return (
    <div
      role="toolbar"
      aria-label="Bulk actions"
      className="flex flex-wrap items-center gap-2 rounded-lg border border-accent/50 bg-accent/[0.08] px-3 py-2 text-xs text-text-secondary"
    >
      <span className="font-semibold text-text-primary">{tasks.length} selected</span>
      <select
        aria-label="Change status of the selected tasks"
        value=""
        disabled={busy}
        onChange={(e) => {
          const status = e.target.value as TaskStatus;
          if (status) onApply({ status }, `Moved to ${STATUS_LABELS[status]}`);
        }}
        className="field w-auto py-1 text-[13px]"
      >
        <option value="">Change status…</option>
        {statuses.map((s) => (
          <option key={s} value={s}>
            {STATUS_LABELS[s]}
          </option>
        ))}
      </select>
      <select
        aria-label="Assign the selected tasks to"
        value=""
        disabled={busy}
        onChange={(e) => {
          const choice = e.target.value;
          if (choice === UNASSIGN) onApply({ assignee: null }, "Unassigned");
          else if (choice) onApply({ assignee: choice }, `Assigned to ${choice}`);
        }}
        title={people.length ? undefined : "Add people on the People page to assign tasks to them"}
        className="field w-auto py-1 text-[13px]"
      >
        <option value="">Assign to…</option>
        {assignees.map((person) => (
          <option key={person.id} value={person.name}>
            {personLabel(person)}
          </option>
        ))}
        <option value={UNASSIGN}>Nobody (unassign)</option>
      </select>
      <button
        type="button"
        className="btn min-h-7 px-2.5 text-xs"
        disabled={busy || !canArchive}
        title={statuses.includes("archived") ? undefined : "The space's status flow doesn't allow archiving every selected task"}
        onClick={() => onApply({ status: "archived" }, "Archived")}
      >
        Archive
      </button>
      <button type="button" className="ml-auto text-text-muted hover:text-text-primary" onClick={onClear}>
        Clear selection
      </button>
      {busy && <span className="text-text-muted">Saving…</span>}
    </div>
  );
}
