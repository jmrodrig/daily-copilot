import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";

import { formatDay, NEUTRAL_TAG, NoteLink, Tag, TagPills } from "../components/TriageBoard";
import { message } from "../lib/api";
import type { CustomFieldDef } from "../lib/space";
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

      {chosen.length > 0 && <BulkToolbar tasks={chosen} flow={flow} busy={busy} onApply={apply} onClear={() => setSelected(new Set())} />}
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
                    <td className="px-2 py-1.5 font-mono text-xs">{task.project_code ?? "—"}</td>
                    <td className="px-2 py-1.5">
                      {task.status === "archived" || task.status === "blocked" ? (
                        <Tag className={task.status === "blocked" ? "border-accent bg-accent/15 text-accent" : NEUTRAL_TAG}>{STATUS_LABELS[task.status]}</Tag>
                      ) : (
                        STATUS_LABELS[task.status]
                      )}
                    </td>
                    <td className="truncate px-2 py-1.5">{task.assignee ?? "—"}</td>
                    <td className={`px-2 py-1.5 font-mono text-xs ${overdue ? "text-accent" : "text-text-muted"}`}>
                      {task.deadline ? formatDay(task.deadline) : "—"}
                    </td>
                    {customFields.map((field) => (
                      <td key={field.id} className="whitespace-nowrap px-2 py-1.5 text-text-muted">
                        {formatValue(field, task.custom_fields[field.id])}
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

function SelectAll({ checked, indeterminate, onChange }: { checked: boolean; indeterminate: boolean; onChange: () => void }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate;
  }, [indeterminate]);
  return <input ref={ref} type="checkbox" aria-label="Select all shown tasks" checked={checked} onChange={onChange} />;
}

/** Actions for the ticked tasks. Only statuses the space's status flow allows for every one of them are offered. */
function BulkToolbar({
  tasks,
  flow,
  busy,
  onApply,
  onClear,
}: {
  tasks: TaskItem[];
  flow: StatusFlow | null;
  busy: boolean;
  onApply: (updates: TaskPatch, what: string) => void;
  onClear: () => void;
}) {
  const [assignee, setAssignee] = useState("");
  const statuses = STATUSES.filter((s) => tasks.every((t) => allowedStatuses(flow, t.status).includes(s)));
  const canArchive = statuses.includes("archived") && tasks.some((t) => t.status !== "archived");

  function assign(event: FormEvent) {
    event.preventDefault();
    const name = assignee.trim();
    onApply({ assignee: name || null }, name ? `Assigned to ${name}` : "Unassigned");
    setAssignee("");
  }

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
      <form onSubmit={assign} className="flex items-center gap-1.5">
        <input
          aria-label="Assign the selected tasks to"
          value={assignee}
          onChange={(e) => setAssignee(e.target.value)}
          placeholder="Assign to… (empty: nobody)"
          className="field w-48 py-1 text-[13px]"
        />
        <button type="submit" className="btn min-h-7 px-2.5 text-xs" disabled={busy}>
          Assign
        </button>
      </form>
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
