import { useEffect, useRef, useState, type KeyboardEvent } from "react";

import { message, sendJson } from "../lib/api";
import { optionColor, pillStyle } from "../lib/colors";
import { AssigneeSelect, type Person } from "../lib/people";
import type { CustomFieldDef } from "../lib/space";
import {
  PRIORITY_LABELS,
  PRIORITY_RANK,
  STATUS_LABELS,
  taskAssignees,
  type CustomFieldValue,
  type ProjectOption,
  type TaskCreate,
  type TaskItem,
  type TaskPriority,
  type TaskStatus,
} from "../lib/tasks";
import type { ViewFilters } from "../lib/views";
import { Dropdown, Row } from "./MultiSelect";
import { ProjectPicker } from "./ProjectPicker";
import { formatDay } from "./TriageBoard";

// Re-exported for the pages that took it from here.
export { ProjectPicker };

// --- Columns ----------------------------------------------------------------------

/** A column of the Backlog or List table: the built-in ones by name, a custom field as `cf:<field id>`. */
export type Column = { id: string; label: string };

export const TITLE_COLUMN = "title";

export function customColumn(field: CustomFieldDef): Column {
  return { id: `cf:${field.id}`, label: field.name };
}

/** A custom field's value as shown in a table cell. */
export function formatCustomValue(field: CustomFieldDef, value: CustomFieldValue | undefined): string {
  if (value === undefined) return "—";
  if (field.type === "checkbox") return value ? "✓" : "—";
  if (field.type === "date" && typeof value === "string") return formatDay(value);
  // A person field holds the person's name.
  return String(value);
}

function readHidden(storageKey: string): Record<string, boolean> | null {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) ?? "null");
    return saved && typeof saved === "object" && !Array.isArray(saved) ? saved : null;
  } catch {
    return null;
  }
}

/**
 * Which of `columns` a table shows, remembered in localStorage under `storageKey`. A column never toggled shows
 * unless it is in `hiddenAtFirst`; the title always shows.
 */
export function useColumns(storageKey: string, columns: Column[], hiddenAtFirst: (id: string) => boolean) {
  // Column id -> shown; only the columns toggled so far.
  const [chosen, setChosen] = useState<Record<string, boolean>>(() => readHidden(storageKey) ?? {});

  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(chosen));
    } catch {
      // Storage full or disabled: the choice lasts until the page is closed.
    }
  }, [storageKey, chosen]);

  const isShown = (id: string) => id === TITLE_COLUMN || (chosen[id] ?? !hiddenAtFirst(id));
  const shown = columns.filter((c) => isShown(c.id));
  const toggle = (id: string) => setChosen((prev) => ({ ...prev, [id]: !isShown(id) }));
  return { shown, isShown, toggle };
}

/** The "Columns" button above a table: a list of its columns with a checkbox each. */
export function ColumnPicker({ columns, isShown, onToggle }: { columns: Column[]; isShown: (id: string) => boolean; onToggle: (id: string) => void }) {
  return (
    <Dropdown label="Columns" summary="Columns" className="w-auto" align="right">
      {columns.map((column) => (
        <Row key={column.id} checked={isShown(column.id)} disabled={column.id === TITLE_COLUMN} onChange={() => onToggle(column.id)}>
          {column.label}
        </Row>
      ))}
    </Dropdown>
  );
}

// --- Sorting ----------------------------------------------------------------------

export type SortDirection = "asc" | "desc";
/** The column a table is sorted by, or null for its own order (earliest due date first, from the server). */
export type Sort = { column: string; direction: SortDirection } | null;

/** The next sort when a column's header is clicked: ascending, then descending, then back to the table's own order. */
export function nextSort(sort: Sort, column: string): Sort {
  if (!sort || sort.column !== column) return { column, direction: "asc" };
  return sort.direction === "asc" ? { column, direction: "desc" } : null;
}

const STATUS_ORDER = Object.keys(STATUS_LABELS) as TaskStatus[];

/** A task's value in a column, for sorting; null for none (always sorted last). */
function sortValue(task: TaskItem, column: string, customFields: CustomFieldDef[]): string | number | null {
  switch (column) {
    case TITLE_COLUMN:
      return task.title;
    case "project":
      return task.project_code || null;
    case "status":
      return STATUS_ORDER.indexOf(task.status);
    case "assignee":
      return taskAssignees(task).join(", ") || null;
    case "priority":
      // Ascending: most pressing (urgent) first, as on the Kanban.
      return PRIORITY_RANK[task.priority];
    case "start":
      return task.start_date;
    case "due":
      return task.deadline;
    case "tags":
      return task.tags.join(", ") || null;
    default: {
      const field = customFields.find((f) => `cf:${f.id}` === column);
      const value = field ? task.custom_fields[field.id] : undefined;
      if (value === undefined || value === null || value === "") return null;
      if (typeof value === "boolean") return value ? 1 : 0;
      return value;
    }
  }
}

/**
 * `tasks` sorted by a column (a copy; `tasks` itself when unsorted). Text sorts alphabetically (numbers within it by
 * value), dates by day, status in workflow order and priority from urgent to low. Tasks without a value come last
 * either way, and ties keep the table's own order.
 */
export function sortTasks(tasks: TaskItem[], sort: Sort, customFields: CustomFieldDef[]): TaskItem[] {
  if (!sort) return tasks;
  const sign = sort.direction === "asc" ? 1 : -1;
  const keyed = tasks.map((task, index) => ({ task, index, value: sortValue(task, sort.column, customFields) }));
  keyed.sort((a, b) => {
    if (a.value === null || b.value === null) {
      if (a.value === b.value) return a.index - b.index;
      return a.value === null ? 1 : -1;
    }
    const order =
      typeof a.value === "number" && typeof b.value === "number"
        ? a.value - b.value
        : String(a.value).localeCompare(String(b.value), undefined, { numeric: true, sensitivity: "base" });
    return order * sign || a.index - b.index;
  });
  return keyed.map((k) => k.task);
}

/** A column header's label as a button that sorts the table by it, with ▲ / ▼ for the current direction. */
export function SortHeader({ column, sort, onSort }: { column: Column; sort: Sort; onSort: (sort: Sort) => void }) {
  const active = sort?.column === column.id ? sort.direction : null;
  return (
    <button
      type="button"
      onClick={() => onSort(nextSort(sort, column.id))}
      title={active === "asc" ? "Sorted ascending: click for descending" : active === "desc" ? "Sorted descending: click to unsort" : `Sort by ${column.label}`}
      className={`group/sort inline-flex max-w-full cursor-pointer select-none items-center gap-1 uppercase tracking-wider hover:text-text-primary ${
        active ? "text-text-primary" : ""
      }`}
    >
      <span className="truncate">{column.label}</span>
      <span aria-hidden className={`shrink-0 text-[10px] ${active ? "" : "opacity-0 group-hover/sort:opacity-60"}`}>
        {active === "asc" ? "▲" : active === "desc" ? "▼" : "↕"}
      </span>
    </button>
  );
}

/** The `aria-sort` of a column's header. */
export function ariaSort(sort: Sort, column: string): "ascending" | "descending" | undefined {
  return sort?.column === column ? (sort.direction === "asc" ? "ascending" : "descending") : undefined;
}

// --- New task ---------------------------------------------------------------------

const NEW_STATUSES = (Object.keys(STATUS_LABELS) as TaskStatus[]).filter((s) => s !== "archived");

/** One value of a list filter for a new task: the only one picked, or the first of several. */
function first<T>(values: T[]): T | null {
  return values.length ? values[0] : null;
}

/** A custom field filter's value as the field's value, when it names one (not "any value" or "no value"). */
function customDefault(field: CustomFieldDef, wanted: string | undefined): CustomFieldValue | null {
  if (wanted === undefined || wanted === "" || wanted === "*") return null;
  if (field.type === "checkbox") return wanted === "true";
  if (field.type === "number") return Number.isFinite(Number(wanted)) ? Number(wanted) : null;
  if (field.type === "dropdown") return field.options.includes(wanted) ? wanted : null;
  return wanted;
}

/** A new task's fields from the view's filters, so it shows in the view it was added to. */
export function newTaskDefaults(filters: ViewFilters, customFields: CustomFieldDef[], fallbackStatus: TaskStatus): NewTaskDraft {
  const custom_fields: Record<string, CustomFieldValue> = {};
  for (const field of customFields) {
    const value = customDefault(field, filters.custom_fields[field.id]);
    if (value !== null) custom_fields[field.id] = value;
  }
  const status = first(filters.status.filter((s) => s !== "archived")) ?? fallbackStatus;
  return {
    title: "",
    project_id: first(filters.project_id),
    // An empty assignee filter asks for unassigned tasks.
    assignee: first(filters.assignee) || null,
    status,
    priority: first(filters.priority) ?? "normal",
    start_date: filters.start_after ?? filters.start_before ?? null,
    deadline: filters.due_before ?? filters.due_after ?? null,
    tags: filters.tag ? [filters.tag] : [],
    custom_fields,
  };
}

export type NewTaskDraft = Required<Pick<TaskCreate, "title" | "project_id" | "assignee" | "status" | "priority" | "start_date" | "deadline" | "tags">> & {
  custom_fields: Record<string, CustomFieldValue>;
};

/**
 * The editable row at the bottom of a task table, one cell per shown column (`columns`, after `leadingCells` empty
 * ones). Enter in the title adds the task and leaves the row open for the next one; Escape closes it.
 */
export function NewTaskRow({
  spaceId,
  columns,
  leadingCells = 0,
  fixedLayout = false,
  defaults,
  projects,
  people,
  customFields,
  onCreated,
  onClose,
}: {
  spaceId: number;
  columns: Column[];
  leadingCells?: number;
  /** The table's columns have set widths (`table-fixed`): the inputs fit them rather than widen them. */
  fixedLayout?: boolean;
  defaults: NewTaskDraft;
  projects: ProjectOption[];
  people: Person[];
  customFields: CustomFieldDef[];
  onCreated: (task: TaskItem) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<NewTaskDraft>(defaults);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleInput = useRef<HTMLInputElement>(null);
  const set = (change: Partial<NewTaskDraft>) => setDraft((prev) => ({ ...prev, ...change }));
  const cell = `field w-full py-1 text-[13px] ${fixedLayout ? "min-w-0 px-1.5" : "min-w-[6.5rem] px-2"}`;

  async function save() {
    if (!draft.title.trim() || saving) return;
    setSaving(true);
    setError(null);
    try {
      const body: TaskCreate = { ...draft, space_id: spaceId, title: draft.title.trim() };
      onCreated(await sendJson<TaskItem>("POST", "/api/tasks", body));
      // Ready for the next one, with the same fields.
      set({ title: "" });
      titleInput.current?.focus({ preventScroll: true });
    } catch (err: unknown) {
      setError(message(err));
    } finally {
      setSaving(false);
    }
  }

  function keys(e: KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      save();
    }
    if (e.key === "Escape") onClose();
  }

  function render(id: string) {
    if (id === TITLE_COLUMN) {
      return (
        <input
          ref={titleInput}
          autoFocus
          aria-label="New task title"
          value={draft.title}
          onChange={(e) => set({ title: e.target.value })}
          onKeyDown={keys}
          placeholder="What needs doing?"
          className={`${cell} ${fixedLayout ? "" : "min-w-[140px]"}`}
        />
      );
    }
    if (id === "project") {
      return <ProjectPicker value={draft.project_id} projects={projects} onChange={(project_id) => set({ project_id })} ariaLabel="New task project" />;
    }
    if (id === "status") {
      return (
        <select aria-label="New task status" value={draft.status} onChange={(e) => set({ status: e.target.value as TaskStatus })} className={cell}>
          {NEW_STATUSES.map((s) => (
            <option key={s} value={s}>
              {STATUS_LABELS[s]}
            </option>
          ))}
        </select>
      );
    }
    if (id === "assignee") {
      return <AssigneeSelect ariaLabel="New task assignee" value={draft.assignee} people={people} emptyLabel="—" onChange={(assignee) => set({ assignee })} className={cell} />;
    }
    if (id === "priority") {
      return (
        <select aria-label="New task priority" value={draft.priority} onChange={(e) => set({ priority: e.target.value as TaskPriority })} className={cell}>
          {(Object.keys(PRIORITY_LABELS) as TaskPriority[]).map((p) => (
            <option key={p} value={p}>
              {PRIORITY_LABELS[p]}
            </option>
          ))}
        </select>
      );
    }
    if (id === "start" || id === "due") {
      const key = id === "start" ? "start_date" : "deadline";
      return (
        <input
          type="date"
          aria-label={`New task ${id === "start" ? "start" : "due"} date`}
          value={draft[key] ?? ""}
          onChange={(e) => set({ [key]: e.target.value || null })}
          onKeyDown={keys}
          className={`${cell} ${fixedLayout ? "" : "min-w-[8rem]"}`}
        />
      );
    }
    const field = customFields.find((f) => `cf:${f.id}` === id);
    return field ? <CustomFieldInput field={field} value={draft.custom_fields[field.id]} people={people} onChange={(value) => setCustom(field.id, value)} onKeyDown={keys} className={cell} /> : null;
  }

  // Fields asked for on inline creation whose column is hidden still get an input, above the actions.
  const extraFields = customFields.filter((f) => f.show_inline && !columns.some((c) => c.id === `cf:${f.id}`));

  function setCustom(id: string, value: CustomFieldValue | null) {
    setDraft((prev) => {
      const custom_fields = { ...prev.custom_fields };
      if (value === null) delete custom_fields[id];
      else custom_fields[id] = value;
      return { ...prev, custom_fields };
    });
  }

  return (
    <>
      <tr aria-label="New task" className="bg-surface-panel/60 align-top">
        {Array.from({ length: leadingCells }, (_, i) => (
          <td key={i} />
        ))}
        {columns.map((column) => (
          <td key={column.id} className={`${column.id === TITLE_COLUMN ? "px-4" : "px-2"} pb-1 pt-2`}>
            {render(column.id)}
          </td>
        ))}
      </tr>
      {/* The actions get a row of their own, as the title cell can be narrow. */}
      <tr className="!border-t-0 bg-surface-panel/60">
        <td colSpan={leadingCells + columns.length} className="px-4 pb-2">
          {extraFields.length > 0 && (
            <div className="mb-2 flex flex-wrap items-center gap-2">
              {extraFields.map((field) => (
                <CustomFieldInput
                  key={field.id}
                  named
                  field={field}
                  value={draft.custom_fields[field.id]}
                  people={people}
                  onChange={(value) => setCustom(field.id, value)}
                  onKeyDown={keys}
                  className="field w-auto px-2 py-1 text-[13px]"
                />
              ))}
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2 text-xs text-text-muted">
            <button type="button" className="btn-primary min-h-7 px-2.5 text-xs" disabled={saving || !draft.title.trim()} onClick={save}>
              {saving ? "Adding…" : "Add task"}
            </button>
            <button type="button" className="btn min-h-7 px-2.5 text-xs" onClick={onClose}>
              Cancel
            </button>
            <span>Enter to add · Esc to cancel</span>
            {error && <span className="text-accent">{error}</span>}
          </div>
        </td>
      </tr>
    </>
  );
}

/**
 * A custom field's input for a new task. `named` shows the field's name (as the placeholder, the empty dropdown
 * choice or the checkbox's label), for inputs without a column header above them. A person field picks from `people`.
 */
export function CustomFieldInput({
  field,
  value,
  people = [],
  onChange,
  onKeyDown,
  className,
  named = false,
}: {
  field: CustomFieldDef;
  value: CustomFieldValue | undefined;
  people?: Person[];
  onChange: (value: CustomFieldValue | null) => void;
  onKeyDown: (e: KeyboardEvent) => void;
  className: string;
  named?: boolean;
}) {
  const label = `New task ${field.name}`;
  if (field.type === "person") {
    return (
      <AssigneeSelect
        ariaLabel={label}
        value={typeof value === "string" ? value : null}
        people={people}
        emptyLabel={named ? `${field.name}…` : "—"}
        onChange={onChange}
        className={className}
      />
    );
  }
  if (field.type === "checkbox") {
    const box = <input type="checkbox" aria-label={label} checked={value === true} onChange={(e) => onChange(e.target.checked || null)} />;
    if (!named) return box;
    return (
      <label className="flex items-center gap-1.5 text-[13px] text-text-secondary">
        {box}
        {field.name}
      </label>
    );
  }
  if (field.type === "dropdown") {
    const color = optionColor(field, value);
    return (
      <select
        aria-label={label}
        title={named ? field.name : undefined}
        value={typeof value === "string" ? value : ""}
        onChange={(e) => onChange(e.target.value || null)}
        style={color ? pillStyle(color) : undefined}
        className={`${className} ${named && typeof value !== "string" ? "text-text-muted" : ""}`}
      >
        <option value="">{named ? `${field.name}…` : "—"}</option>
        {field.options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    );
  }
  const input = (
    <input
      aria-label={label}
      title={named ? field.name : undefined}
      placeholder={named ? field.name : undefined}
      type={field.type === "date" ? "date" : field.type === "number" ? "number" : "text"}
      value={value === undefined ? "" : String(value)}
      onChange={(e) => {
        const text = e.target.value;
        onChange(text === "" ? null : field.type === "number" ? Number(text) : text);
      }}
      onKeyDown={onKeyDown}
      className={`${className} min-w-[90px]`}
    />
  );
  if (!named || field.type !== "date") return input;
  // A date input shows no placeholder: name it beside.
  return (
    <label className="flex items-center gap-1.5 text-[13px] text-text-muted">
      {field.name}
      {input}
    </label>
  );
}

/** The "+ Add task" button under a task table. */
export function AddTaskButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-2 px-4 py-2 text-left text-[13px] text-text-muted hover:bg-surface-panel hover:text-text-primary"
    >
      <span aria-hidden className="flex h-4 w-4 items-center justify-center rounded border border-border-strong font-mono text-[12px] leading-none">
        +
      </span>
      Add task
    </button>
  );
}
