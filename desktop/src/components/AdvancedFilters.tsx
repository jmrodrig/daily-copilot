import { useEffect, useState, type ReactNode } from "react";

import type { CustomFieldDef } from "../lib/space";
import { PRIORITY_LABELS, STATUS_LABELS } from "../lib/tasks";
import { advancedFilterCount, NO_ADVANCED_FILTERS, type ViewFilters } from "../lib/views";

// Filter values with a special meaning (see `_custom_field_matches` in backend/main.py).
const NO_VALUE = "";
const ANY_VALUE = "*";

// A <select> value meaning "this filter is off"; no field value can be it (values are trimmed).
const OFF = " off";
// For text, number and date fields: the value typed (or picked) must match.
const IS = " is";

/**
 * The collapsible "Advanced filters" of the task views: priority, status, whether tasks are Gantt tasks or milestones
 * or linked to a note, whether they have (and when) a due date or start date, and the space's custom fields. Open at
 * first when any of them is set.
 */
export default function AdvancedFilters({
  filters,
  customFields,
  onFilters,
}: {
  filters: ViewFilters;
  customFields: CustomFieldDef[];
  onFilters: (filters: ViewFilters) => void;
}) {
  const count = advancedFilterCount(filters);
  const [open, setOpen] = useState(count > 0);
  const set = (change: Partial<ViewFilters>) => onFilters({ ...filters, ...change });

  function setCustom(id: string, value: string | null) {
    const custom_fields = { ...filters.custom_fields };
    if (value === null) delete custom_fields[id];
    else custom_fields[id] = value;
    set({ custom_fields });
  }

  const known = new Set(customFields.map((f) => f.id));
  // A saved view can filter on a field the space has since removed (the server ignores it).
  const stale = Object.keys(filters.custom_fields).filter((id) => !known.has(id));

  return (
    <details
      open={open}
      onToggle={(e) => setOpen(e.currentTarget.open)}
      className="rounded-lg border border-border-default bg-surface-raised text-xs text-text-muted"
    >
      <summary className="cursor-pointer select-none px-3 py-2 text-[13px] text-text-secondary">
        Advanced filters{count > 0 && <span className="ml-1.5 font-mono text-accent">({count})</span>}
      </summary>
      <div className="flex flex-col gap-3 border-t border-border-default px-3 py-3">
        <div className="flex flex-wrap items-start gap-3">
          <Labelled label="Due date">
            <PresenceSelect value={filters.has_deadline} onChange={(has_deadline) => set({ has_deadline })} what="a due date" />
          </Labelled>
          <Labelled label="Due on or after">
            <input
              type="date"
              value={filters.due_after ?? ""}
              onChange={(e) => set({ due_after: e.target.value || null })}
              className="field w-40 py-1 text-[13px]"
            />
          </Labelled>
          <Labelled label="Due on or before">
            <input
              type="date"
              value={filters.due_before ?? ""}
              onChange={(e) => set({ due_before: e.target.value || null })}
              className="field w-40 py-1 text-[13px]"
            />
          </Labelled>
          <Labelled label="Start date">
            <PresenceSelect value={filters.has_start_date} onChange={(has_start_date) => set({ has_start_date })} what="a start date" />
          </Labelled>
          <Labelled label="Start on or after">
            <input
              type="date"
              value={filters.start_after ?? ""}
              onChange={(e) => set({ start_after: e.target.value || null })}
              className="field w-40 py-1 text-[13px]"
            />
          </Labelled>
          <Labelled label="Start on or before">
            <input
              type="date"
              value={filters.start_before ?? ""}
              onChange={(e) => set({ start_before: e.target.value || null })}
              className="field w-40 py-1 text-[13px]"
            />
          </Labelled>
        </div>

        <div className="flex flex-wrap items-start gap-3 border-t border-border-default/60 pt-3">
          <Labelled label="Priority">
            <ChoiceSelect value={filters.priority} labels={PRIORITY_LABELS} onChange={(priority) => set({ priority })} />
          </Labelled>
          <Labelled label="Status">
            <ChoiceSelect
              value={filters.status}
              labels={STATUS_LABELS}
              onChange={(status) => set({ status })}
            />
          </Labelled>
          <Labelled label="Gantt task">
            <YesNoSelect value={filters.is_gantt_task} onChange={(is_gantt_task) => set({ is_gantt_task })} />
          </Labelled>
          <Labelled label="Milestone">
            <YesNoSelect value={filters.is_milestone} onChange={(is_milestone) => set({ is_milestone })} />
          </Labelled>
          <Labelled label="Linked note">
            <PresenceSelect value={filters.has_note} onChange={(has_note) => set({ has_note })} what="a linked note" />
          </Labelled>
        </div>

        {customFields.length > 0 && (
          <div className="flex flex-wrap items-start gap-3 border-t border-border-default/60 pt-3">
            {customFields.map((field) => (
              <Labelled key={field.id} label={field.name}>
                <CustomFieldFilter field={field} value={filters.custom_fields[field.id] ?? null} onChange={(value) => setCustom(field.id, value)} />
              </Labelled>
            ))}
          </div>
        )}

        {stale.length > 0 && (
          <p className="flex flex-wrap items-center gap-2">
            Filters on removed fields (ignored):
            {stale.map((id) => (
              <button key={id} type="button" className="chip hover:text-text-primary" title="Remove this filter" onClick={() => setCustom(id, null)}>
                {id} ×
              </button>
            ))}
          </p>
        )}

        {count > 0 && (
          <button type="button" className="self-start text-text-muted hover:text-text-primary" onClick={() => set(NO_ADVANCED_FILTERS)}>
            Clear advanced filters
          </button>
        )}
      </div>
    </details>
  );
}

function Labelled({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[12px] font-semibold uppercase tracking-[0.06em]">{label}</span>
      {children}
    </label>
  );
}

/** Any / has / hasn't, for the due and start dates. */
function PresenceSelect({ value, onChange, what }: { value: boolean | null; onChange: (value: boolean | null) => void; what: string }) {
  return (
    <select
      value={value === null ? OFF : String(value)}
      onChange={(e) => onChange(e.target.value === OFF ? null : e.target.value === "true")}
      className="field w-40 py-1 text-[13px]"
    >
      <option value={OFF}>Any</option>
      <option value="true">Has {what}</option>
      <option value="false">No {what}</option>
    </select>
  );
}

/** Any / yes / no, for the task's Gantt task and milestone flags. */
function YesNoSelect({ value, onChange }: { value: boolean | null; onChange: (value: boolean | null) => void }) {
  return (
    <select
      value={value === null ? OFF : String(value)}
      onChange={(e) => onChange(e.target.value === OFF ? null : e.target.value === "true")}
      className="field w-40 py-1 text-[13px]"
    >
      <option value={OFF}>Any</option>
      <option value="true">Yes</option>
      <option value="false">No</option>
    </select>
  );
}

/** Any, or one of `labels`' keys (priority, status). */
function ChoiceSelect<T extends string>({ value, labels, onChange }: { value: T | null; labels: Record<T, string>; onChange: (value: T | null) => void }) {
  return (
    <select value={value ?? OFF} onChange={(e) => onChange(e.target.value === OFF ? null : (e.target.value as T))} className="field w-40 py-1 text-[13px]">
      <option value={OFF}>Any</option>
      {(Object.keys(labels) as T[]).map((key) => (
        <option key={key} value={key}>
          {labels[key]}
        </option>
      ))}
    </select>
  );
}

/** The filter on one custom field; `null` is off. */
function CustomFieldFilter({ field, value, onChange }: { field: CustomFieldDef; value: string | null; onChange: (value: string | null) => void }) {
  // "Is…" picked but nothing typed yet: the box shows while the filter is still off.
  const [pickedIs, setPickedIs] = useState(false);
  const select = "field w-40 py-1 text-[13px]";
  const presence = (
    <>
      <option value={OFF}>Any</option>
      <option value={ANY_VALUE}>Has a value</option>
      <option value={NO_VALUE}>No value</option>
    </>
  );

  if (field.type === "checkbox") {
    return (
      <select
        aria-label={`Filter on ${field.name}`}
        value={value === null ? OFF : value === "true" ? "true" : "false"}
        onChange={(e) => onChange(e.target.value === OFF ? null : e.target.value)}
        className={select}
      >
        <option value={OFF}>Any</option>
        <option value="true">Ticked</option>
        <option value="false">Not ticked</option>
      </select>
    );
  }

  if (field.type === "dropdown") {
    return (
      <select
        aria-label={`Filter on ${field.name}`}
        value={value ?? OFF}
        onChange={(e) => onChange(e.target.value === OFF ? null : e.target.value)}
        className={select}
      >
        {presence}
        {field.options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
        {/* A saved filter on an option since removed from the field. */}
        {value !== null && value !== ANY_VALUE && value !== NO_VALUE && !field.options.includes(value) && <option value={value}>{value}</option>}
      </select>
    );
  }

  // Text, number and date: Any / Has a value / No value, or "Is…" with the value to match.
  const mode = value === null ? OFF : value === ANY_VALUE || value === NO_VALUE ? value : IS;
  return (
    <span className="flex items-center gap-1.5">
      <select
        aria-label={`Filter on ${field.name}`}
        value={mode}
        onChange={(e) => {
          const next = e.target.value;
          // "Is…" waits for a value; until one is typed the filter stays off.
          onChange(next === OFF || next === IS ? null : next);
          setPickedIs(next === IS);
        }}
        className="field w-32 py-1 text-[13px]"
      >
        {presence}
        <option value={IS}>{field.type === "text" ? "Contains…" : "Is…"}</option>
      </select>
      {(mode === IS || pickedIs) && (
        <DraftInput
          ariaLabel={`${field.name} to match`}
          type={field.type === "date" ? "date" : field.type === "number" ? "number" : "text"}
          value={mode === IS ? value! : ""}
          onCommit={(text) => onChange(text.trim() ? text.trim() : null)}
        />
      )}
    </span>
  );
}

/** A text box that applies its value on blur or Enter (dates as soon as one is picked), not on every keystroke. */
function DraftInput({ value, onCommit, ariaLabel, type }: { value: string; onCommit: (text: string) => void; ariaLabel: string; type: string }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = (text = draft) => text !== value && onCommit(text);
  return (
    <input
      aria-label={ariaLabel}
      type={type}
      value={draft}
      onChange={(e) => {
        setDraft(e.target.value);
        if (type === "date") commit(e.target.value);
      }}
      onBlur={() => commit()}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
        if (e.key === "Escape") setDraft(value);
      }}
      className="field w-36 py-1 text-[13px]"
    />
  );
}
