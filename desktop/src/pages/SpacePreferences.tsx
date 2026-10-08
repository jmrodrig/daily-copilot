import { useEffect, useState, type FormEvent } from "react";
import { useLocation } from "react-router-dom";

import ColorPicker from "../components/ColorPicker";
import { Tag } from "../components/TriageBoard";
import { getJson, message, sendJson } from "../lib/api";
import { pillStyle } from "../lib/colors";
import { useSpace, type CustomFieldDef, type CustomFieldType, type Space } from "../lib/space";
import { DEFAULT_STATUS_COLORS, statusColor, STATUS_LABELS, STATUSES, type ProjectOption, type ProjectUpdate, type StatusFlow, type TaskStatus } from "../lib/tasks";
import { useTitle } from "../lib/title";

export default function SpacePreferences() {
  const { space, updateSpace } = useSpace();
  const [name, setName] = useState(space?.name ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  useTitle("Space preferences");
  const { hash } = useLocation();

  // `/space-preferences#projects` (from a project folder's menu) scrolls to that section once it's there.
  useEffect(() => {
    if (hash && space) document.getElementById(hash.slice(1))?.scrollIntoView();
  }, [hash, space?.id]);

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
        <StatusColorsEditor
          key={`colors-${space.id}`}
          space={space}
          onSave={(colors) => updateSpace(space.id, { status_colors: { ...space.status_colors, ...colors } })}
        />
      )}
      {space && (
        <CustomFieldsEditor
          key={`fields-${space.id}`}
          space={space}
          onSave={({ fields, renames }) => updateSpace(space.id, { custom_fields_schema: fields, renamed_options: renames })}
        />
      )}
      {space && <ProjectsEditor key={`projects-${space.id}`} spaceId={space.id} />}
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

// --- Status colours ----------------------------------------------------------------

/**
 * The colour of each status, shown as the dot on task pills. Saves every status's colour, so a status set back to its
 * default stays on it even if the defaults change.
 */
function StatusColorsEditor({ space, onSave }: { space: Space; onSave: (colors: Record<TaskStatus, string>) => Promise<unknown> }) {
  const current = () => Object.fromEntries(STATUSES.map((s) => [s, statusColor(space.status_colors, s)])) as Record<TaskStatus, string>;
  const [colors, setColors] = useState(current);
  const { save, saving, status, touched } = useSaver(onSave);
  const dirty = JSON.stringify(colors) !== JSON.stringify(current());

  function pick(state: TaskStatus, color: string) {
    touched();
    setColors((prev) => ({ ...prev, [state]: color.toLowerCase() }));
  }

  return (
    <section className="panel flex flex-col gap-3" aria-label="Status colors">
      <div>
        <h2 className="text-base font-semibold">Status colors</h2>
        <p className="mt-1 text-[15px] text-text-muted">The colour of each status, shown as a dot on the task pills in notes.</p>
      </div>
      <ul className="grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-3">
        {STATUSES.map((state) => (
          <li key={state} className="flex items-center gap-2 text-[15px]">
            <input
              type="color"
              aria-label={`Colour of ${STATUS_LABELS[state]}`}
              value={colors[state]}
              onChange={(e) => pick(state, e.target.value)}
              className="h-7 w-9 shrink-0 cursor-pointer rounded border border-border-default bg-transparent p-0.5"
            />
            <span className="flex-1">{STATUS_LABELS[state]}</span>
            {colors[state] !== DEFAULT_STATUS_COLORS[state] && (
              <button
                type="button"
                className="text-xs text-text-muted hover:text-text-primary"
                title="Back to the default colour"
                onClick={() => pick(state, DEFAULT_STATUS_COLORS[state])}
              >
                Reset
              </button>
            )}
          </li>
        ))}
      </ul>
      {status}
      <div className="flex gap-2">
        <button type="button" className="btn-primary" disabled={!dirty || saving} onClick={() => save(colors)}>
          {saving ? "Saving…" : "Save"}
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

/** A dropdown option being edited: `original` is its saved name (null if new), so a rename carries tasks over. */
type OptionDraft = { key: number; name: string; original: string | null; color: string | null };
type FieldDraft = { id: string; name: string; type: CustomFieldType; options: OptionDraft[]; showInline: boolean };

let nextOptionKey = 1;

function optionDraft(name: string, original: string | null, color: string | null): OptionDraft {
  return { key: nextOptionKey++, name, original, color };
}

function draftsOf(fields: CustomFieldDef[]): FieldDraft[] {
  return fields.map((f) => ({
    id: f.id,
    name: f.name,
    type: f.type,
    options: f.options.map((o) => optionDraft(o, o, f.colors?.[o] ?? null)),
    showInline: f.show_inline ?? false,
  }));
}

/** The options of a draft as saved: trimmed, without blanks or repeats (the first one's colour wins). */
function cleanOptions(draft: FieldDraft): OptionDraft[] {
  const seen = new Set<string>();
  return draft.options.flatMap((o) => {
    const name = o.name.trim();
    if (!name || seen.has(name)) return [];
    seen.add(name);
    return [{ ...o, name }];
  });
}

function schemaOf(drafts: FieldDraft[]): CustomFieldDef[] {
  return drafts.map((d) => {
    const options = d.type === "dropdown" ? cleanOptions(d) : [];
    return {
      id: d.id,
      name: d.name.trim(),
      type: d.type,
      options: options.map((o) => o.name),
      colors: Object.fromEntries(options.filter((o) => o.color).map((o) => [o.name, o.color!])),
      show_inline: d.showInline,
    };
  });
}

/** Field id -> old option -> new name, for the saved dropdown options that were renamed. */
function renamesOf(drafts: FieldDraft[], saved: CustomFieldDef[]): Record<string, Record<string, string>> {
  const renames: Record<string, Record<string, string>> = {};
  for (const draft of drafts) {
    if (draft.type !== "dropdown" || saved.find((f) => f.id === draft.id)?.type !== "dropdown") continue;
    for (const option of cleanOptions(draft)) {
      if (option.original !== null && option.original !== option.name) (renames[draft.id] ??= {})[option.original] = option.name;
    }
  }
  return renames;
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

type FieldsSave = { fields: CustomFieldDef[]; renames: Record<string, Record<string, string>> };

/**
 * The space's custom fields: click one to edit its name, type and (for a dropdown) its options and their colours.
 * Renamed options keep the tasks that held them; removing a field (or changing its type) clears the tasks' values that
 * no longer fit when saved.
 */
function CustomFieldsEditor({ space, onSave }: { space: Space; onSave: (change: FieldsSave) => Promise<Space> }) {
  const saved = space.custom_fields_schema;
  const [drafts, setDrafts] = useState(() => draftsOf(saved));
  const [editing, setEditing] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [type, setType] = useState<CustomFieldType>("text");
  // After saving, start again from what the server kept (options' saved names included).
  const { save, saving, status, touched } = useSaver(async (change: FieldsSave) => setDrafts(draftsOf((await onSave(change)).custom_fields_schema)));

  const schema = schemaOf(drafts);
  const renames = renamesOf(drafts, saved);
  const dirty = JSON.stringify(schema) !== JSON.stringify(schemaOf(draftsOf(saved)));
  const valid = schema.every((f) => f.name && (f.type !== "dropdown" || f.options.length > 0));

  function add(event: FormEvent) {
    event.preventDefault();
    if (!name.trim()) return;
    touched();
    const id = fieldId(name, new Set(drafts.map((f) => f.id)));
    setDrafts((prev) => [...prev, { id, name: name.trim(), type, options: type === "dropdown" ? [optionDraft("", null, null)] : [], showInline: false }]);
    setEditing(id);
    setName("");
  }

  function update(id: string, change: (draft: FieldDraft) => Partial<FieldDraft>) {
    touched();
    setDrafts((prev) => prev.map((f) => (f.id === id ? { ...f, ...change(f) } : f)));
  }

  function remove(field: FieldDraft) {
    const wasSaved = saved.some((f) => f.id === field.id);
    if (wasSaved && !window.confirm(`Remove the field "${field.name}"? When you save, tasks lose their values for it.`)) return;
    touched();
    setDrafts((prev) => prev.filter((f) => f.id !== field.id));
  }

  return (
    <section className="panel flex flex-col gap-3" aria-label="Custom fields">
      <div>
        <h2 className="text-base font-semibold">Custom fields</h2>
        <p className="mt-1 text-[15px] text-text-muted">
          Extra fields every task in this space gets, shown in the task panel and the List view. Click a field to edit it;
          give a dropdown's options colours to show them as coloured pills on cards and to colour the Gantt by them.
        </p>
      </div>
      {drafts.length === 0 ? (
        <p className="text-[15px] text-text-muted">No custom fields yet.</p>
      ) : (
        <ul className="flex flex-col divide-y divide-border-default/60 rounded-lg border border-border-default">
          {drafts.map((field) => (
            <li key={field.id}>
              <FieldRow
                field={field}
                savedField={saved.find((f) => f.id === field.id)}
                open={editing === field.id}
                onToggle={() => setEditing((prev) => (prev === field.id ? null : field.id))}
                onChange={(change) => update(field.id, change)}
                onRemove={() => remove(field)}
              />
            </li>
          ))}
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
        <button type="button" className="btn-primary" disabled={!dirty || !valid || saving} onClick={() => save({ fields: schema, renames })}>
          {saving ? "Saving…" : "Save"}
        </button>
        {dirty && (
          <button
            type="button"
            className="btn"
            onClick={() => {
              touched();
              setDrafts(draftsOf(saved));
            }}
          >
            Revert
          </button>
        )}
      </div>
    </section>
  );
}

/** One field: a summary line that opens its editor. */
function FieldRow({
  field,
  savedField,
  open,
  onToggle,
  onChange,
  onRemove,
}: {
  field: FieldDraft;
  savedField: CustomFieldDef | undefined;
  open: boolean;
  onToggle: () => void;
  onChange: (change: (draft: FieldDraft) => Partial<FieldDraft>) => void;
  onRemove: () => void;
}) {
  const label = field.name.trim() || "field";
  const options = cleanOptions(field);
  const invalid = !field.name.trim() || (field.type === "dropdown" && options.length === 0);
  const typeChanged = savedField !== undefined && savedField.type !== field.type;

  function setOption(key: number, change: Partial<OptionDraft>) {
    onChange((d) => ({ options: d.options.map((o) => (o.key === key ? { ...o, ...change } : o)) }));
  }

  return (
    <div className={open ? "bg-surface-panel/60" : ""}>
      <button
        type="button"
        aria-expanded={open}
        aria-label={`Edit ${label}`}
        onClick={onToggle}
        className="flex w-full flex-wrap items-center gap-2 px-3 py-2 text-left hover:bg-surface-hover"
      >
        <span aria-hidden className={`inline-block text-[11px] text-text-muted transition-transform ${open ? "rotate-90" : ""}`}>
          ▶
        </span>
        <span className={`font-medium ${field.name.trim() ? "text-text-primary" : "text-text-muted"}`}>{field.name.trim() || "Unnamed field"}</span>
        <span className="font-mono text-[12px] uppercase tracking-wider text-text-muted">{FIELD_TYPES[field.type]}</span>
        {field.type === "dropdown" &&
          options.map((o) => (
            <Tag key={o.key} className={o.color ? "normal-case" : "normal-case border-border-default text-text-secondary"} style={o.color ? pillStyle(o.color) : undefined}>
              {o.name}
            </Tag>
          ))}
        {field.showInline && <span className="text-xs text-text-muted">· On new task cards</span>}
        {invalid && <span className="text-xs text-accent">Incomplete</span>}
      </button>

      {open && (
        <div className="flex flex-col gap-2.5 px-3 pb-3 pl-8">
          <div className="flex items-center gap-2">
            <input
              aria-label={`Name of ${label}`}
              value={field.name}
              onChange={(e) => onChange(() => ({ name: e.target.value }))}
              maxLength={64}
              className={`field flex-1 py-1.5 ${field.name.trim() ? "" : "border-accent"}`}
            />
            <select
              aria-label={`Type of ${label}`}
              value={field.type}
              onChange={(e) => {
                const next = e.target.value as CustomFieldType;
                onChange((d) => ({ type: next, options: next === "dropdown" && d.options.length === 0 ? [optionDraft("", null, null)] : d.options }));
              }}
              className="field w-32 py-1.5"
            >
              {Object.entries(FIELD_TYPES).map(([value, text]) => (
                <option key={value} value={value}>
                  {text}
                </option>
              ))}
            </select>
            <button type="button" className="btn min-h-9 px-3 text-xs" onClick={onRemove}>
              Remove
            </button>
          </div>
          <label className="flex w-fit items-center gap-2 text-[14px] text-text-secondary">
            <input type="checkbox" checked={field.showInline} onChange={(e) => onChange(() => ({ showInline: e.target.checked }))} />
            Show in inline creation
            <span className="text-xs text-text-muted">(the "Add task" card and the List view's new task row)</span>
          </label>
          {typeChanged && (
            <p className="text-xs text-accent">
              Was {FIELD_TYPES[savedField.type]}: when you save, tasks' values that aren't valid for a {FIELD_TYPES[field.type].toLowerCase()} field are
              cleared.
            </p>
          )}
          {field.type === "dropdown" && (
            <div className="flex flex-col gap-1.5">
              <span className="text-[13px] font-semibold tracking-[0.08em] text-text-muted">OPTIONS</span>
              <ul className="flex flex-col gap-1.5">
                {field.options.map((option, index) => (
                  <li key={option.key} className="flex flex-col gap-0.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <input
                        aria-label={`Option ${index + 1} of ${label}`}
                        value={option.name}
                        onChange={(e) => setOption(option.key, { name: e.target.value })}
                        placeholder="Option"
                        maxLength={128}
                        className="field w-48 py-1"
                      />
                      <ColorPicker
                        label={option.name.trim() || `option ${index + 1}`}
                        value={option.color}
                        onChange={(color) => setOption(option.key, { color })}
                      />
                      <button
                        type="button"
                        aria-label={`Remove option ${option.name.trim() || index + 1}`}
                        title="Remove option (tasks keep it until changed)"
                        className="ml-auto px-1 text-text-muted hover:text-accent"
                        onClick={() => onChange((d) => ({ options: d.options.filter((o) => o.key !== option.key) }))}
                      >
                        ×
                      </button>
                    </div>
                    {option.original !== null && option.name.trim() && option.name.trim() !== option.original && (
                      <span className="text-xs text-text-muted">
                        Renamed from “{option.original}”: tasks holding it move to the new name.
                      </span>
                    )}
                  </li>
                ))}
              </ul>
              <button
                type="button"
                className="self-start text-xs text-text-secondary hover:text-text-primary"
                onClick={() => onChange((d) => ({ options: [...d.options, optionDraft("", null, null)] }))}
              >
                + Add option
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// --- Projects -----------------------------------------------------------------------

/** The space's projects (folders marked as Project): their names and colours for pills and Gantt bars. */
function ProjectsEditor({ spaceId }: { spaceId: number }) {
  const { refreshTree } = useSpace();
  const [projects, setProjects] = useState<ProjectOption[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    getJson<ProjectOption[]>(`/api/projects?space_id=${spaceId}`, controller.signal)
      .then(setProjects)
      .catch((err: unknown) => {
        if (!controller.signal.aborted) setLoadError(message(err));
      });
    return () => controller.abort();
  }, [spaceId]);

  return (
    <section id="projects" className="panel flex scroll-mt-4 flex-col gap-3" aria-label="Projects">
      <div>
        <h2 className="text-base font-semibold">Projects</h2>
        <p className="mt-1 text-[15px] text-text-muted">
          A project's colour is used for its pills and its Gantt bars. Mark a folder as Project in the sidebar to add one.
        </p>
      </div>
      {loadError && <p className="text-[15px] text-text-secondary">Could not load the projects ({loadError}).</p>}
      {projects === null && !loadError && <p className="text-[15px] text-text-muted">Loading…</p>}
      {projects?.length === 0 && <p className="text-[15px] text-text-muted">No projects in this space yet.</p>}
      {projects && projects.length > 0 && (
        <ul className="flex flex-col divide-y divide-border-default/60">
          {projects.map((project) => (
            <li key={project.id} className="py-2.5 first:pt-0 last:pb-0">
              <ProjectRow
                project={project}
                onSaved={(next) => {
                  setProjects((prev) => prev && prev.map((p) => (p.id === next.id ? { ...p, ...next } : p)));
                  refreshTree(); // the sidebar shows project colours
                }}
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ProjectRow({ project, onSaved }: { project: ProjectOption; onSaved: (project: ProjectOption) => void }) {
  const [name, setName] = useState(project.name);
  const [color, setColor] = useState(project.color);
  const { save, saving, status, touched } = useSaver(async (change: ProjectUpdate) => {
    const saved = await sendJson<ProjectOption>("PUT", `/api/projects/${project.id}`, change);
    onSaved({ ...project, name: saved.name, color: saved.color });
  });
  const dirty = name.trim() !== project.name || color !== project.color;

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <span
          className="rounded border px-1.5 py-px font-mono text-[12px] uppercase leading-4"
          style={color ? pillStyle(color) : undefined}
        >
          {project.code}
        </span>
        <input
          aria-label={`Name of ${project.code}`}
          value={name}
          onChange={(e) => {
            touched();
            setName(e.target.value);
          }}
          maxLength={200}
          className="field min-w-24 flex-1 py-1"
        />
        <ColorPicker
          label={project.code}
          value={color}
          onChange={(next) => {
            touched();
            setColor(next);
          }}
        />
        <button
          type="button"
          className="btn-primary min-h-8 shrink-0 px-3 text-xs"
          disabled={!dirty || !name.trim() || saving}
          onClick={() => save({ name: name.trim(), color })}
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
      {status}
    </div>
  );
}
