import { useState, type FormEvent, type ReactNode } from "react";

import { AssigneeSelect, AssigneesSelect, type Person } from "../lib/people";
import type { CustomFieldDef } from "../lib/space";
import TagEditor from "./TagEditor";
import {
  allowedStatuses,
  assigneesPatch,
  PRIORITY_LABELS,
  STATUS_LABELS,
  STATUSES,
  taskAssignees,
  type CustomFieldValue,
  type StatusFlow,
  type TaskItem,
  type TaskPatch,
  type TaskPriority,
  type TaskStatus,
} from "../lib/tasks";

/**
 * The values being edited. A number field's value is kept as typed until applied; `null` clears a date or custom field.
 * `assignees` and `tags` replace each task's own (empty unassigns, or clears the tags).
 */
type Draft = {
  status: TaskStatus | null;
  assignees: string[];
  tags: string[];
  priority: TaskPriority;
  start_date: string | null;
  deadline: string | null;
  is_gantt_task: boolean;
  is_milestone: boolean;
  custom_fields: Record<string, CustomFieldValue | null>;
};

// A custom field's key in the set of fields to change; the task's own fields use their names.
const cfKey = (id: string) => `cf:${id}`;

/** The value every task has in common, or `fallback` when they differ. */
function common<T>(tasks: TaskItem[], get: (task: TaskItem) => T, fallback: T): T {
  const first = get(tasks[0]);
  return tasks.every((t) => get(t) === first) ? first : fallback;
}

/** The list every task has in common (in the same order), or [] when they differ. */
function commonList(tasks: TaskItem[], get: (task: TaskItem) => string[]): string[] {
  const key = (task: TaskItem) => JSON.stringify(get(task));
  return common(tasks, key, "[]") === "[]" ? [] : get(tasks[0]);
}

function initialDraft(tasks: TaskItem[], statuses: TaskStatus[], customFields: CustomFieldDef[]): Draft {
  const status = common<TaskStatus | null>(tasks, (t) => t.status, null);
  return {
    status: status !== null && statuses.includes(status) ? status : (statuses[0] ?? null),
    assignees: commonList(tasks, taskAssignees),
    tags: commonList(tasks, (t) => t.tags),
    priority: common(tasks, (t) => t.priority, "normal"),
    start_date: common(tasks, (t) => t.start_date, null),
    deadline: common(tasks, (t) => t.deadline, null),
    is_gantt_task: common(tasks, (t) => t.is_gantt_task, false),
    is_milestone: common(tasks, (t) => t.is_milestone, false),
    custom_fields: Object.fromEntries(
      customFields.map((field) => {
        const value = common<CustomFieldValue | null>(tasks, (t) => t.custom_fields[field.id] ?? null, null);
        return [field.id, field.type === "checkbox" ? value === true : field.type === "number" && value !== null ? String(value) : value];
      }),
    ),
  };
}

/** A custom field's draft value as sent: blank text and numbers clear the field; `undefined` is a number that isn't one. */
function customValue(field: CustomFieldDef, value: CustomFieldValue | null): CustomFieldValue | null | undefined {
  if (field.type === "checkbox") return value === true;
  if (value === null || value === "") return null;
  if (field.type === "number") {
    const number = Number(value);
    return Number.isFinite(number) ? number : undefined;
  }
  return typeof value === "string" ? value.trim() || null : value;
}

/**
 * Changes any field of several tasks at once (the List view's "Bulk edit…"). Only the ticked fields are sent, as one
 * `TaskPatch`; the rest are left as each task has them. Fields start at the value the tasks share, if they all do.
 */
export default function BulkEditDialog({
  tasks,
  flow,
  people,
  customFields,
  onApply,
  onClose,
}: {
  tasks: TaskItem[];
  flow: StatusFlow | null;
  people: Person[];
  customFields: CustomFieldDef[];
  onApply: (updates: TaskPatch, what: string) => void;
  onClose: () => void;
}) {
  // Only statuses the space's status flow allows for every task.
  const statuses = STATUSES.filter((s) => tasks.every((t) => allowedStatuses(flow, t.status).includes(s)));
  const [enabled, setEnabled] = useState<Set<string>>(new Set());
  const [draft, setDraft] = useState<Draft>(() => initialDraft(tasks, statuses, customFields));

  const set = (change: Partial<Draft>) => setDraft((prev) => ({ ...prev, ...change }));
  const setCustom = (id: string, value: CustomFieldValue | null) =>
    setDraft((prev) => ({ ...prev, custom_fields: { ...prev.custom_fields, [id]: value } }));
  const toggle = (key: string) =>
    setEnabled((prev) => {
      const next = new Set(prev);
      if (!next.delete(key)) next.add(key);
      return next;
    });

  const patch: TaskPatch = {};
  let invalid = false;
  if (enabled.has("status") && draft.status !== null) patch.status = draft.status;
  if (enabled.has("assignees")) Object.assign(patch, assigneesPatch(draft.assignees));
  if (enabled.has("tags")) patch.tags = draft.tags;
  if (enabled.has("priority")) patch.priority = draft.priority;
  if (enabled.has("start_date")) patch.start_date = draft.start_date;
  if (enabled.has("deadline")) patch.deadline = draft.deadline;
  if (enabled.has("is_gantt_task")) patch.is_gantt_task = draft.is_gantt_task;
  if (enabled.has("is_milestone")) patch.is_milestone = draft.is_milestone;
  for (const field of customFields) {
    if (!enabled.has(cfKey(field.id))) continue;
    const value = customValue(field, draft.custom_fields[field.id] ?? null);
    if (value === undefined) invalid = true;
    else (patch.custom_fields ??= {})[field.id] = value;
  }
  const empty = Object.keys(patch).length === 0;

  function submit(event?: FormEvent) {
    event?.preventDefault();
    if (empty || invalid) return;
    onApply(patch, "Bulk edit");
    onClose();
  }

  const input = "field w-full py-1 text-[13px]";
  const row = (key: string, label: string, control: ReactNode, disabledReason?: string) => (
    <Row key={key} label={label} checked={enabled.has(key)} onToggle={() => toggle(key)} disabledReason={disabledReason}>
      {control}
    </Row>
  );

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 pt-[10vh]" onMouseDown={onClose}>
      <form
        role="dialog"
        aria-modal
        aria-label="Bulk edit"
        onSubmit={submit}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
        }}
        className="panel flex max-h-[80vh] w-[520px] flex-col gap-3"
      >
        <h2 className="text-base font-semibold">
          Bulk edit {tasks.length} task{tasks.length === 1 ? "" : "s"}
        </h2>
        <p className="text-xs text-text-muted">Tick the fields to change; the others are left as they are.</p>

        <div className="-mx-1 flex flex-col overflow-y-auto px-1">
          {row(
            "status",
            "Status",
            <select aria-label="New status" value={draft.status ?? ""} onChange={(e) => set({ status: e.target.value as TaskStatus })} className={input}>
              {statuses.map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABELS[s]}
                </option>
              ))}
            </select>,
            statuses.length ? undefined : "The space's status flow allows no status for every selected task",
          )}
          {row(
            "assignees",
            "Assignees",
            <AssigneesSelect
              value={draft.assignees}
              people={people}
              onChange={(assignees) => set({ assignees })}
              ariaLabel="New assignees"
              emptyLabel="Nobody (unassign)"
              className={input}
            />,
          )}
          {row(
            "tags",
            "Tags",
            <div className="flex flex-col gap-1">
              <TagEditor spaceId={tasks[0].space_id} label="New tags" tags={draft.tags} onChange={(tags) => set({ tags })} />
              <span className="text-xs text-text-muted">Replaces each task&apos;s tags{draft.tags.length === 0 ? ": none clears them" : ""}.</span>
            </div>,
          )}
          {row(
            "priority",
            "Priority",
            <select aria-label="New priority" value={draft.priority} onChange={(e) => set({ priority: e.target.value as TaskPriority })} className={input}>
              {(Object.keys(PRIORITY_LABELS) as TaskPriority[]).map((p) => (
                <option key={p} value={p}>
                  {PRIORITY_LABELS[p]}
                </option>
              ))}
            </select>,
          )}
          {row("start_date", "Start date", <DateInput label="New start date" value={draft.start_date} onChange={(start_date) => set({ start_date })} />)}
          {row("deadline", "Due date", <DateInput label="New due date" value={draft.deadline} onChange={(deadline) => set({ deadline })} />)}
          {row(
            "is_gantt_task",
            "Gantt task",
            <YesNo label="Gantt task" value={draft.is_gantt_task} onChange={(is_gantt_task) => set({ is_gantt_task })} className={input} />,
          )}
          {row(
            "is_milestone",
            "Milestone",
            <YesNo label="Milestone" value={draft.is_milestone} onChange={(is_milestone) => set({ is_milestone })} className={input} />,
          )}
          {customFields.map((field) =>
            row(
              cfKey(field.id),
              field.name,
              <CustomFieldInput
                field={field}
                value={draft.custom_fields[field.id] ?? null}
                people={people}
                onChange={(value) => setCustom(field.id, value)}
                className={input}
              />,
            ),
          )}
        </div>

        {invalid && <p className="text-xs text-accent">Enter a number, or leave it blank to clear the field.</p>}
        <div className="flex justify-end gap-2 border-t border-border-default/60 pt-3">
          <button type="button" className="btn min-h-9 px-3 text-xs" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn-primary min-h-9 px-3 text-xs" disabled={empty || invalid}>
            Apply changes
          </button>
        </div>
      </form>
    </div>
  );
}

/** One field: a checkbox that includes it in the change, and its input once ticked. */
function Row({
  label,
  checked,
  onToggle,
  disabledReason,
  children,
}: {
  label: string;
  checked: boolean;
  onToggle: () => void;
  disabledReason?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-10 items-center gap-3 border-b border-border-default/40 py-1.5 last:border-b-0">
      <label className="flex w-40 shrink-0 items-center gap-2 text-[13px] text-text-secondary" title={disabledReason}>
        <input type="checkbox" aria-label={`Change ${label}`} checked={checked} disabled={!!disabledReason} onChange={onToggle} />
        <span className="truncate">{label}</span>
      </label>
      <div className="min-w-0 flex-1">{checked ? children : <span className="text-xs text-text-muted">Unchanged</span>}</div>
    </div>
  );
}

/** A date, or none: "Clear date" sets the tasks' date to none. */
function DateInput({ label, value, onChange }: { label: string; value: string | null; onChange: (value: string | null) => void }) {
  return (
    <div className="flex items-center gap-2">
      <input
        type="date"
        aria-label={label}
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value || null)}
        className={`field w-40 py-1 text-[13px] ${value ? "text-text-primary" : "text-text-muted"}`}
      />
      {value === null ? (
        <span className="text-xs text-text-muted">Will be cleared</span>
      ) : (
        <button type="button" className="text-xs text-text-muted hover:text-text-primary" onClick={() => onChange(null)}>
          Clear date
        </button>
      )}
    </div>
  );
}

function YesNo({ label, value, onChange, className }: { label: string; value: boolean; onChange: (value: boolean) => void; className: string }) {
  return (
    <select aria-label={`New ${label.toLowerCase()} value`} value={String(value)} onChange={(e) => onChange(e.target.value === "true")} className={className}>
      <option value="true">Yes</option>
      <option value="false">No</option>
    </select>
  );
}

/** The input for one custom field's new value; blank (or "—") clears the field. */
function CustomFieldInput({
  field,
  value,
  people,
  onChange,
  className,
}: {
  field: CustomFieldDef;
  value: CustomFieldValue | null;
  people: Person[];
  onChange: (value: CustomFieldValue | null) => void;
  className: string;
}) {
  const label = `New ${field.name}`;
  switch (field.type) {
    case "checkbox":
      return (
        <label className="flex items-center gap-2 text-[13px] text-text-secondary">
          <input type="checkbox" aria-label={label} checked={value === true} onChange={(e) => onChange(e.target.checked)} />
          {value === true ? "Ticked" : "Not ticked"}
        </label>
      );
    case "date":
      return <DateInput label={label} value={typeof value === "string" ? value : null} onChange={onChange} />;
    case "person":
      return (
        <AssigneeSelect
          ariaLabel={label}
          value={typeof value === "string" ? value : null}
          people={people}
          emptyLabel="— (clear)"
          onChange={onChange}
          className={className}
        />
      );
    case "dropdown": {
      const current = typeof value === "string" ? value : "";
      return (
        <select aria-label={label} value={current} onChange={(e) => onChange(e.target.value || null)} className={className}>
          <option value="">— (clear)</option>
          {field.options.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
          {/* A value the tasks share whose option was since removed. */}
          {current && !field.options.includes(current) && <option value={current}>{current}</option>}
        </select>
      );
    }
    default:
      return (
        <input
          type={field.type === "number" ? "number" : "text"}
          aria-label={label}
          value={value === null ? "" : String(value)}
          onChange={(e) => onChange(e.target.value)}
          placeholder="Blank clears the field"
          className={className}
        />
      );
  }
}
