import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";

import { formatDay, NEUTRAL_TAG, PROJECT_TAG, RANK_LABELS, Tag, type TriageItem } from "../components/TriageBoard";

// Time sheet projects; "Inbox" is logged without a project (see TimeEntry in backend/schemas.py).
const PROJECTS = [
  { code: "C7801", label: "C7801" },
  { code: "R5301", label: "R5301" },
  { code: "P5002", label: "P5002" },
  { code: "Inbox", label: "Inbox / Overhead" },
];
const MAX_HOURS = 24;
const REDIRECT_MS = 2500;

type Tasks = { state: "loading" } | { state: "ok"; items: TriageItem[] } | { state: "error"; message: string };
type Row = { key: number; project: string; hours: string; notes: string };
type Submit =
  | { state: "idle" }
  | { state: "saving" }
  | { state: "done"; tasks: number; hours: number }
  | { state: "error"; message: string };

let nextRowKey = 0;
const newRow = (project = PROJECTS[0].code): Row => ({ key: nextRowKey++, project, hours: "", notes: "" });

/** "task:12" → 12 */
const taskId = (item: TriageItem) => Number(item.id.slice("task:".length));

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

export default function EveningCheckIn() {
  const navigate = useNavigate();
  const [tasks, setTasks] = useState<Tasks>({ state: "loading" });
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [rows, setRows] = useState<Row[]>(() => [newRow()]);
  const [submit, setSubmit] = useState<Submit>({ state: "idle" });

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/triage", { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const items: TriageItem[] = await res.json();
        setTasks({ state: "ok", items: items.filter((item) => item.kind === "gantt_task") });
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setTasks({ state: "error", message: err instanceof Error ? err.message : String(err) });
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (submit.state !== "done") return;
    const timer = setTimeout(() => navigate("/"), REDIRECT_MS);
    return () => clearTimeout(timer);
  }, [submit.state, navigate]);

  const toggle = (id: string) =>
    setChecked((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const updateRow = (key: number, patch: Partial<Row>) =>
    setRows((prev) => prev.map((row) => (row.key === key ? { ...row, ...patch } : row)));

  // Rows with no hours are ignored; anything else must be a sensible number of hours.
  const filled = rows.filter((row) => row.hours.trim() !== "");
  const invalid = filled.some((row) => !(Number(row.hours) > 0 && Number(row.hours) <= MAX_HOURS));
  const totalHours = invalid ? 0 : filled.reduce((sum, row) => sum + Number(row.hours), 0);
  const canSubmit = submit.state !== "saving" && submit.state !== "done" && !invalid && (checked.size > 0 || filled.length > 0);

  async function handleSubmit() {
    setSubmit({ state: "saving" });
    try {
      const res = await fetch("/api/checkin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          completed_task_ids: tasks.state === "ok" ? tasks.items.filter((i) => checked.has(i.id)).map(taskId) : [],
          time_entries: filled.map((row) => ({ project: row.project, hours: Number(row.hours), notes: row.notes })),
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        const detail = typeof body?.detail === "string" ? body.detail : `HTTP ${res.status}`;
        throw new Error(detail);
      }
      const body: { completed_task_ids: number[]; total_hours: number } = await res.json();
      setSubmit({ state: "done", tasks: body.completed_task_ids.length, hours: body.total_hours });
    } catch (err: unknown) {
      setSubmit({ state: "error", message: err instanceof Error ? err.message : String(err) });
    }
  }

  if (submit.state === "done") {
    return (
      <div className="mx-auto mt-16 max-w-xl rounded-lg border border-accent/60 bg-surface-raised p-8 text-center">
        <p className="mb-3 text-4xl">🎉</p>
        <h1 className="mb-2 text-2xl font-semibold">Day closed out</h1>
        <p className="text-text-secondary">
          {plural(submit.tasks, "task")} done · {submit.hours} h logged. Tomorrow's list is clean.
        </p>
        <p className="mt-4 text-xs text-text-muted">Back to the Dashboard…</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Evening Check-in</h1>
      <div className="grid max-w-6xl gap-6 lg:grid-cols-2">
        <section>
          <h2 className="mb-3 flex items-center justify-between text-xs font-medium uppercase tracking-wider text-text-muted">
            <span>Today's Active Tasks</span>
            {checked.size > 0 && <span className="font-mono text-accent">{checked.size} done</span>}
          </h2>
          <TaskList tasks={tasks} checked={checked} onToggle={toggle} />
        </section>

        <section>
          <h2 className="mb-3 text-xs font-medium uppercase tracking-wider text-text-muted">Time Sheet</h2>
          <div className="rounded-lg border border-border-default bg-surface-raised p-4">
            <div className="space-y-2">
              {rows.map((row) => (
                <div key={row.key} className="flex items-center gap-2">
                  <select
                    value={row.project}
                    onChange={(e) => updateRow(row.key, { project: e.target.value })}
                    className="w-40 rounded border border-border-light bg-surface-panel px-2 py-1.5 text-sm"
                    aria-label="Project"
                  >
                    {PROJECTS.map(({ code, label }) => (
                      <option key={code} value={code}>
                        {label}
                      </option>
                    ))}
                  </select>
                  <input
                    type="number"
                    min={0}
                    max={MAX_HOURS}
                    step={0.25}
                    placeholder="h"
                    value={row.hours}
                    onChange={(e) => updateRow(row.key, { hours: e.target.value })}
                    className="w-20 rounded border border-border-light bg-surface-panel px-2 py-1.5 font-mono text-sm"
                    aria-label="Hours"
                  />
                  <input
                    type="text"
                    placeholder="Notes"
                    value={row.notes}
                    onChange={(e) => updateRow(row.key, { notes: e.target.value })}
                    className="min-w-0 flex-1 rounded border border-border-light bg-surface-panel px-2 py-1.5 text-sm"
                    aria-label="Notes"
                  />
                  <button
                    type="button"
                    onClick={() => setRows((prev) => prev.filter((r) => r.key !== row.key))}
                    className="rounded px-2 py-1 text-text-muted hover:bg-surface-panel hover:text-text-primary"
                    aria-label="Remove row"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
            <div className="mt-3 flex items-center justify-between border-t border-border-default pt-3">
              <button
                type="button"
                onClick={() => {
                  // Default to the next project not yet on the sheet, so logging several projects is quick.
                  const used = new Set(rows.map((r) => r.project));
                  setRows((prev) => [...prev, newRow(PROJECTS.find((p) => !used.has(p.code))?.code)]);
                }}
                className="rounded border border-border-light px-3 py-1 text-sm text-text-secondary hover:bg-surface-panel hover:text-text-primary"
              >
                + Add row
              </button>
              <span className="font-mono text-sm text-text-secondary">
                {invalid ? <span className="text-accent">Hours must be 0–{MAX_HOURS}</span> : `Total ${totalHours} h`}
              </span>
            </div>
          </div>
        </section>
      </div>

      <div className="flex max-w-6xl items-center justify-end gap-4">
        {submit.state === "error" && (
          <span className="text-sm text-text-secondary">Could not save the check-in ({submit.message}).</span>
        )}
        <button
          type="button"
          onClick={handleSubmit}
          disabled={!canSubmit}
          className="rounded-lg bg-accent px-6 py-3 font-semibold text-background hover:bg-accent/90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {submit.state === "saving" ? "Saving…" : "Submit Check-in"}
        </button>
      </div>
    </div>
  );
}

function TaskList({
  tasks,
  checked,
  onToggle,
}: {
  tasks: Tasks;
  checked: Set<string>;
  onToggle: (id: string) => void;
}) {
  if (tasks.state === "loading") return <p className="text-sm text-text-secondary">Loading /api/triage…</p>;
  if (tasks.state === "error") {
    return <p className="text-sm text-text-secondary">Could not load today's tasks ({tasks.message}).</p>;
  }
  if (tasks.items.length === 0) {
    return (
      <p className="rounded-lg border border-border-default bg-surface-raised p-5 text-sm text-text-secondary">
        No active Gantt tasks.
      </p>
    );
  }

  // Items arrive sorted by rank, so grouping preserves the server's order.
  const groups = new Map<TriageItem["rank"], TriageItem[]>();
  for (const item of tasks.items) groups.set(item.rank, [...(groups.get(item.rank) ?? []), item]);

  return (
    <div className="divide-y divide-border-default overflow-hidden rounded-lg border border-border-default bg-surface-raised">
      {[...groups].map(([rank, items]) => (
        <div key={rank}>
          <h3
            className={`flex items-center justify-between bg-surface-panel px-4 py-2 text-xs font-medium uppercase tracking-wider ${
              rank === 1 ? "text-accent" : "text-text-muted"
            }`}
          >
            <span>{RANK_LABELS[rank]}</span>
            <span className="font-mono">{items.length}</span>
          </h3>
          <ul className="divide-y divide-border-default/60">
            {items.map((item) => (
              <li key={item.id}>
                <label className="flex cursor-pointer items-center gap-3 px-4 py-2.5 hover:bg-surface-panel">
                  <input
                    type="checkbox"
                    checked={checked.has(item.id)}
                    onChange={() => onToggle(item.id)}
                    className="h-4 w-4 shrink-0 accent-accent"
                  />
                  <span
                    className={`min-w-0 flex-1 text-sm ${
                      checked.has(item.id) ? "text-text-muted line-through" : "text-text-primary"
                    }`}
                  >
                    {item.title}
                  </span>
                  <Tag className={item.project ? PROJECT_TAG[item.project.toLowerCase()] ?? NEUTRAL_TAG : NEUTRAL_TAG}>
                    {item.project ?? "Inbox"}
                  </Tag>
                  {item.due_date && (
                    <span className="shrink-0 font-mono text-xs text-text-muted">Due {formatDay(item.due_date)}</span>
                  )}
                </label>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
