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

/** A move in the matrix: forbidden, allowed, or allowed but asking for a comment (see StatusChangeDialog). */
type Move = "blocked" | "allowed" | "comment";
type Matrix = Record<TaskStatus, Partial<Record<TaskStatus, Move>>>;

const NEXT_MOVE: Record<Move, Move> = { blocked: "allowed", allowed: "comment", comment: "blocked" };
const MOVE_LABELS: Record<Move, string> = { blocked: "not allowed", allowed: "allowed", comment: "allowed, asks for a comment" };

function matrixOf(flow: StatusFlow | null): Matrix {
  return Object.fromEntries(
    STATUSES.map((from) => {
      const targets = flow?.[from];
      const moves = STATUSES.filter((to) => to !== from).map((to) => {
        const move: Move = !targets ? "allowed" : !(to in targets) ? "blocked" : targets[to] ? "comment" : "allowed";
        return [to, move];
      });
      return [from, Object.fromEntries(moves)];
    }),
  ) as Matrix;
}

/**
 * The flow to store: a status that may move anywhere without a comment is left out (unrestricted); `null` when
 * nothing is restricted or asks for a comment.
 */
function flowOf(matrix: Matrix): StatusFlow | null {
  const flow: StatusFlow = {};
  for (const from of STATUSES) {
    const moves = STATUSES.filter((to) => to !== from).map((to) => [to, matrix[from][to] ?? "allowed"] as const);
    if (moves.every(([, move]) => move === "allowed")) continue;
    flow[from] = Object.fromEntries(moves.filter(([, move]) => move !== "blocked").map(([to, move]) => [to, move === "comment"]));
  }
  return Object.keys(flow).length ? flow : null;
}

function StatusFlowEditor({ space, onSave }: { space: Space; onSave: (flow: StatusFlow | null) => Promise<unknown> }) {
  const [matrix, setMatrix] = useState(() => matrixOf(space.status_flow));
  const { save, saving, status, touched } = useSaver(onSave);
  const dirty = JSON.stringify(flowOf(matrix)) !== JSON.stringify(flowOf(matrixOf(space.status_flow)));

  function cycle(from: TaskStatus, to: TaskStatus) {
    touched();
    setMatrix((prev) => ({ ...prev, [from]: { ...prev[from], [to]: NEXT_MOVE[prev[from][to] ?? "allowed"] } }));
  }

  return (
    <section className="panel flex flex-col gap-3" aria-label="Status flow">
      <div>
        <h2 className="text-base font-semibold">Status flow</h2>
        <p className="mt-1 text-[15px] text-text-muted">
          Which statuses a task may move to from each status. Click a cell to cycle it: allowed (✓), allowed but asking
          for a comment (✓ 💬), not allowed (blank). Status pickers only offer the allowed moves, and only moves marked 💬
          ask for a comment.
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
                {STATUSES.map((to) => {
                  if (from === to) {
                    return (
                      <td key={to} className="px-2 py-1.5 text-center">
                        <span className="text-text-muted">—</span>
                      </td>
                    );
                  }
                  const move = matrix[from][to] ?? "allowed";
                  const label = `${STATUS_LABELS[from]} → ${STATUS_LABELS[to]}: ${MOVE_LABELS[move]}`;
                  return (
                    <td key={to} className="px-1 py-1 text-center">
                      <button
                        type="button"
                        aria-label={label}
                        title={`${label} (click to change)`}
                        data-move={move}
                        onClick={() => cycle(from, to)}
                        className={`inline-flex h-7 min-w-11 items-center justify-center gap-0.5 rounded-md border px-1.5 ${
                          move === "blocked"
                            ? "border-border-default text-text-muted hover:border-border-strong"
                            : "border-accent/50 bg-accent/10 text-text-primary hover:border-accent"
                        }`}
                      >
                        {move !== "blocked" && <span aria-hidden>✓</span>}
                        {move === "comment" && <span aria-hidden>💬</span>}
                      </button>
                    </td>
                  );
                })}
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

const FIELD_TYPES: Record<CustomFieldType, string> = {
  text: "Text",
  number: "Number",
  date: "Date",
  checkbox: "Checkbox",
  dropdown: "Dropdown",
};

/** A dropdown's options typed as comma-separated values, trimmed and without blanks or repeats. */
function parseOptions(text: string): string[] {
  return [...new Set(text.split(",").map((o) => o.trim()).filter(Boolean))];
}

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

function optionTextsOf(fields: CustomFieldDef[]): Record<string, string> {
  return Object.fromEntries(fields.map((f) => [f.id, f.options.join(", ")]));
}

function CustomFieldsEditor({ space, onSave }: { space: Space; onSave: (fields: CustomFieldDef[]) => Promise<unknown> }) {
  const [fields, setFields] = useState(space.custom_fields_schema);
  const [name, setName] = useState("");
  const [type, setType] = useState<CustomFieldType>("text");
  const [options, setOptions] = useState("");
  // Each dropdown's options as typed (comma-separated), so a trailing comma or space survives while typing.
  const [optionTexts, setOptionTexts] = useState<Record<string, string>>(() => optionTextsOf(space.custom_fields_schema));
  const { save, saving, status, touched } = useSaver(onSave);
  const dirty = JSON.stringify(fields) !== JSON.stringify(space.custom_fields_schema);
  const valid = fields.every((f) => f.name.trim() && (f.type !== "dropdown" || f.options.length > 0));
  const canAdd = name.trim() !== "" && (type !== "dropdown" || parseOptions(options).length > 0);

  function add(event: FormEvent) {
    event.preventDefault();
    if (!canAdd) return;
    touched();
    const id = fieldId(name, new Set(fields.map((f) => f.id)));
    const choices = type === "dropdown" ? parseOptions(options) : [];
    setFields((prev) => [...prev, { id, name: name.trim(), type, options: choices }]);
    setOptionTexts((prev) => ({ ...prev, [id]: choices.join(", ") }));
    setName("");
    setOptions("");
  }

  function update(id: string, change: Partial<CustomFieldDef>) {
    touched();
    setFields((prev) => prev.map((f) => (f.id === id ? { ...f, ...change } : f)));
  }

  function changeType(field: CustomFieldDef, next: CustomFieldType) {
    update(field.id, { type: next, options: next === "dropdown" ? parseOptions(optionTexts[field.id] ?? "") : [] });
  }

  function changeOptions(field: CustomFieldDef, text: string) {
    setOptionTexts((prev) => ({ ...prev, [field.id]: text }));
    update(field.id, { options: parseOptions(text) });
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
              <li key={field.id} className="flex flex-col gap-1.5">
                <div className="flex items-center gap-2">
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
                    onChange={(e) => changeType(field, e.target.value as CustomFieldType)}
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
                </div>
                {field.type === "dropdown" && (
                  <input
                    aria-label={`Options of ${field.name || "field"}`}
                    value={optionTexts[field.id] ?? field.options.join(", ")}
                    onChange={(e) => changeOptions(field, e.target.value)}
                    placeholder="Options, separated by commas, e.g. North yard, South yard"
                    className={`field py-1.5 ${field.options.length === 0 ? "border-accent" : ""}`}
                  />
                )}
              </li>
            );
          })}
        </ul>
      )}
      <form onSubmit={add} className="flex flex-col gap-2 border-t border-border-default pt-3">
        <div className="flex items-end gap-2">
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
          <button type="submit" className="btn min-h-9" disabled={!canAdd}>
            Add
          </button>
        </div>
        {type === "dropdown" && (
          <input
            aria-label="Options of the new field"
            value={options}
            onChange={(e) => setOptions(e.target.value)}
            placeholder="Options, separated by commas, e.g. North yard, South yard"
            className="field py-1.5"
          />
        )}
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
              setOptionTexts(optionTextsOf(space.custom_fields_schema));
            }}
          >
            Revert
          </button>
        )}
      </div>
    </section>
  );
}
