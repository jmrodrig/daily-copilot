import { useEffect, useState, type FormEvent } from "react";

import { message } from "../lib/api";
import { useSpace, type CustomFieldDef, type CustomFieldType, type Space } from "../lib/space";
import { STATUS_LABELS, STATUSES, type StatusFlow, type TaskStatus } from "../lib/tasks";
import { useTitle } from "../lib/title";

export default function SpacePreferences() {
  const { space, updateSpace } = useSpace();
  const [name, setName] = useState(space?.name ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  useTitle("Space preferences");

  // Reset the form when the active space changes (or the spaces finish loading).
  useEffect(() => {
    setName(space?.name ?? "");
    setError(null);
    setSaved(false);
  }, [space?.id, space?.name]);

  const trimmed = name.trim();
  const valid = space !== undefined && trimmed !== "" && trimmed !== space.name;

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!space || !valid || saving) return;
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      await updateSpace(space.id, { name: trimmed });
      setSaved(true);
    } catch (err: unknown) {
      setError(message(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex max-w-3xl flex-col gap-5 px-9 py-7">
      <header>
        <div className="font-mono text-xs tracking-[0.06em] text-text-muted">SPACE PREFERENCES</div>
        <h1 className="mt-1 text-[29px] font-semibold">{space?.name ?? "Space"}</h1>
        <div className="mt-1 text-[15px] text-text-muted">Configure the current space.</div>
      </header>

      <section className="panel flex flex-col gap-3" aria-label="General">
        <h2 className="text-base font-semibold">General</h2>
        {space === undefined ? (
          <p className="text-[15px] text-text-muted">Loading…</p>
        ) : (
          <form onSubmit={save} className="flex flex-col gap-3">
            <label className="flex flex-col gap-1.5">
              <span className="text-[13px] font-semibold tracking-[0.08em] text-text-muted">NAME</span>
              <input
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  setSaved(false);
                }}
                className="field"
                maxLength={64}
                required
              />
            </label>
            {error && <p className="text-xs text-accent">Could not save ({error}).</p>}
            {saved && <p className="text-xs text-text-secondary">Saved.</p>}
            <div className="flex gap-2">
              <button type="submit" className="btn-primary" disabled={!valid || saving}>
                {saving ? "Saving…" : "Save"}
              </button>
            </div>
          </form>
        )}
      </section>

      {space && <StatusFlowEditor key={`flow-${space.id}`} space={space} onSave={(status_flow) => updateSpace(space.id, { status_flow })} />}
      {space && (
        <CustomFieldsEditor
          key={`fields-${space.id}`}
          space={space}
          onSave={(custom_fields_schema) => updateSpace(space.id, { custom_fields_schema })}
        />
      )}
    </div>
  );
}

/** Save state shared by the preference sections: a Save button, then "Saved." or the error. */
function useSaver<T>(onSave: (value: T) => Promise<unknown>) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  async function save(value: T) {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      await onSave(value);
      setSaved(true);
    } catch (err: unknown) {
      setError(message(err));
    } finally {
      setSaving(false);
    }
  }
  const status = (
    <>
      {error && <p className="text-xs text-accent">Could not save ({error}).</p>}
      {saved && <p className="text-xs text-text-secondary">Saved.</p>}
    </>
  );
  return { save, saving, status, touched: () => setSaved(false) };
}

// --- Status flow --------------------------------------------------------------------

type Matrix = Record<TaskStatus, TaskStatus[]>;

function matrixOf(flow: StatusFlow | null): Matrix {
  return Object.fromEntries(STATUSES.map((from) => [from, flow?.[from] ?? STATUSES.filter((to) => to !== from)])) as Matrix;
}

/** The flow to store: a status that may move anywhere is left out (unrestricted); `null` when nothing is restricted. */
function flowOf(matrix: Matrix): StatusFlow | null {
  const flow: StatusFlow = {};
  for (const from of STATUSES) {
    const targets = STATUSES.filter((to) => to !== from && matrix[from].includes(to));
    if (targets.length < STATUSES.length - 1) flow[from] = targets;
  }
  return Object.keys(flow).length ? flow : null;
}

function StatusFlowEditor({ space, onSave }: { space: Space; onSave: (flow: StatusFlow | null) => Promise<unknown> }) {
  const [matrix, setMatrix] = useState(() => matrixOf(space.status_flow));
  const { save, saving, status, touched } = useSaver(onSave);
  const dirty = JSON.stringify(flowOf(matrix)) !== JSON.stringify(flowOf(matrixOf(space.status_flow)));

  function toggle(from: TaskStatus, to: TaskStatus) {
    touched();
    setMatrix((prev) => ({
      ...prev,
      [from]: prev[from].includes(to) ? prev[from].filter((s) => s !== to) : [...prev[from], to],
    }));
  }

  return (
    <section className="panel flex flex-col gap-3" aria-label="Status flow">
      <div>
        <h2 className="text-base font-semibold">Status flow</h2>
        <p className="mt-1 text-[15px] text-text-muted">
          Which statuses a task may move to from each status. Untick a box to forbid that move; status pickers then only
          offer the allowed ones. Everything ticked means no restrictions.
        </p>
      </div>
      <div className="overflow-x-auto">
        <table className="text-[13px]">
          <thead>
            <tr className="text-text-muted">
              <th className="px-2 py-1.5 text-left font-medium">From ↓ / to →</th>
              {STATUSES.map((to) => (
                <th key={to} className="px-2 py-1.5 text-center font-medium">
                  {STATUS_LABELS[to]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-border-default/60">
            {STATUSES.map((from) => (
              <tr key={from}>
                <th scope="row" className="whitespace-nowrap px-2 py-1.5 text-left font-medium text-text-secondary">
                  {STATUS_LABELS[from]}
                </th>
                {STATUSES.map((to) => (
                  <td key={to} className="px-2 py-1.5 text-center">
                    {from === to ? (
                      <span className="text-text-muted">—</span>
                    ) : (
                      <input
                        type="checkbox"
                        aria-label={`Allow ${STATUS_LABELS[from]} → ${STATUS_LABELS[to]}`}
                        checked={matrix[from].includes(to)}
                        onChange={() => toggle(from, to)}
                      />
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {status}
      <div className="flex gap-2">
        <button type="button" className="btn-primary" disabled={!dirty || saving} onClick={() => save(flowOf(matrix))}>
          {saving ? "Saving…" : "Save"}
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => {
            touched();
            setMatrix(matrixOf(null));
          }}
        >
          Allow every move
        </button>
      </div>
    </section>
  );
}

// --- Custom fields ------------------------------------------------------------------

const FIELD_TYPES: Record<CustomFieldType, string> = { text: "Text", number: "Number", date: "Date", checkbox: "Checkbox" };

/** A stable id for a new field: its name as a slug, numbered if taken. */
function fieldId(name: string, taken: Set<string>): string {
  const base =
    name
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 56) || "field";
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}_${n}`;
  return id;
}

function CustomFieldsEditor({ space, onSave }: { space: Space; onSave: (fields: CustomFieldDef[]) => Promise<unknown> }) {
  const [fields, setFields] = useState(space.custom_fields_schema);
  const [name, setName] = useState("");
  const [type, setType] = useState<CustomFieldType>("text");
  const { save, saving, status, touched } = useSaver(onSave);
  const dirty = JSON.stringify(fields) !== JSON.stringify(space.custom_fields_schema);
  const valid = fields.every((f) => f.name.trim());

  function add(event: FormEvent) {
    event.preventDefault();
    if (!name.trim()) return;
    touched();
    setFields((prev) => [...prev, { id: fieldId(name, new Set(prev.map((f) => f.id))), name: name.trim(), type }]);
    setName("");
  }

  function update(id: string, change: Partial<CustomFieldDef>) {
    touched();
    setFields((prev) => prev.map((f) => (f.id === id ? { ...f, ...change } : f)));
  }

  function remove(field: CustomFieldDef) {
    const saved = space.custom_fields_schema.some((f) => f.id === field.id);
    if (saved && !window.confirm(`Remove the field "${field.name}"? Tasks keep their values, but they are no longer shown.`)) return;
    touched();
    setFields((prev) => prev.filter((f) => f.id !== field.id));
  }

  return (
    <section className="panel flex flex-col gap-3" aria-label="Custom fields">
      <div>
        <h2 className="text-base font-semibold">Custom fields</h2>
        <p className="mt-1 text-[15px] text-text-muted">Extra fields every task in this space gets, shown in the task panel and the List view.</p>
      </div>
      {fields.length === 0 ? (
        <p className="text-[15px] text-text-muted">No custom fields yet.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {fields.map((field) => {
            const saved = space.custom_fields_schema.some((f) => f.id === field.id);
            return (
              <li key={field.id} className="flex items-center gap-2">
                <input
                  aria-label={`Name of ${field.name || "field"}`}
                  value={field.name}
                  onChange={(e) => update(field.id, { name: e.target.value })}
                  maxLength={64}
                  className="field flex-1 py-1.5"
                />
                <select
                  aria-label={`Type of ${field.name || "field"}`}
                  value={field.type}
                  // A saved field's values were stored for its type, so only new fields can change it.
                  disabled={saved}
                  title={saved ? "The type of a saved field can't change" : undefined}
                  onChange={(e) => update(field.id, { type: e.target.value as CustomFieldType })}
                  className="field w-32 py-1.5"
                >
                  {Object.entries(FIELD_TYPES).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
                <button type="button" className="btn min-h-9 px-3 text-xs" onClick={() => remove(field)}>
                  Remove
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <form onSubmit={add} className="flex items-end gap-2 border-t border-border-default pt-3">
        <label className="flex flex-1 flex-col gap-1.5">
          <span className="text-[13px] font-semibold tracking-[0.08em] text-text-muted">NEW FIELD</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Hull number" maxLength={64} className="field py-1.5" />
        </label>
        <select aria-label="Type of the new field" value={type} onChange={(e) => setType(e.target.value as CustomFieldType)} className="field w-32 py-1.5">
          {Object.entries(FIELD_TYPES).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
        <button type="submit" className="btn min-h-9" disabled={!name.trim()}>
          Add
        </button>
      </form>
      {status}
      <div className="flex gap-2">
        <button
          type="button"
          className="btn-primary"
          disabled={!dirty || !valid || saving}
          onClick={() => save(fields.map((f) => ({ ...f, name: f.name.trim() })))}
        >
          {saving ? "Saving…" : "Save"}
        </button>
        {dirty && (
          <button
            type="button"
            className="btn"
            onClick={() => {
              touched();
              setFields(space.custom_fields_schema);
            }}
          >
            Revert
          </button>
        )}
      </div>
    </section>
  );
}
