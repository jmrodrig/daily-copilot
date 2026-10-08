import { useEffect, useRef, useState, type KeyboardEvent } from "react";

import { message, sendJson } from "../lib/api";
import { AssigneeSelect, type Person } from "../lib/people";
import type { CustomFieldDef } from "../lib/space";
import {
  PRIORITY_LABELS,
  STATUS_LABELS,
  type CustomFieldValue,
  type ProjectOption,
  type TaskCreate,
  type TaskItem,
  type TaskPriority,
  type TaskStatus,
} from "../lib/tasks";
import type { ViewFilters } from "../lib/views";
import { Dropdown, Row } from "./MultiSelect";
import { formatDay } from "./TriageBoard";

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
      titleInput.current?.focus();
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
      return (
        <select aria-label="New task project" value={draft.project_id ?? ""} onChange={(e) => set({ project_id: e.target.value ? Number(e.target.value) : null })} className={cell}>
          <option value="">—</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.code}
            </option>
          ))}
        </select>
      );
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
    return field ? <CustomFieldInput field={field} value={draft.custom_fields[field.id]} onChange={(value) => setCustom(field.id, value)} onKeyDown={keys} className={cell} /> : null;
  }

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

function CustomFieldInput({
  field,
  value,
  onChange,
  onKeyDown,
  className,
}: {
  field: CustomFieldDef;
  value: CustomFieldValue | undefined;
  onChange: (value: CustomFieldValue | null) => void;
  onKeyDown: (e: KeyboardEvent) => void;
  className: string;
}) {
  const label = `New task ${field.name}`;
  if (field.type === "checkbox") {
    return <input type="checkbox" aria-label={label} checked={value === true} onChange={(e) => onChange(e.target.checked || null)} />;
  }
  if (field.type === "dropdown") {
    return (
      <select aria-label={label} value={typeof value === "string" ? value : ""} onChange={(e) => onChange(e.target.value || null)} className={className}>
        <option value="">—</option>
        {field.options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    );
  }
  return (
    <input
      aria-label={label}
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
