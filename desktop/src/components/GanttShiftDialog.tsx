import { useState, type FormEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { formatDay, formatDelta, fromDay, toDay, todayDay } from "../lib/days";
import type { GanttDateChange, GanttTask } from "./GanttChart";

/** How a shift moves one task: both dates, or only its due date (a task already under way at the reference date). */
export type ShiftedTask = { task: GanttTask; change: GanttDateChange; dueOnly: boolean };

/**
 * The tasks a shift of `delta` days from `reference` moves, and their new dates. With `futureOnly`, a task starting on
 * or after the reference date moves entirely, one under way then (due on or after it) only has its due date moved,
 * and one finished before it stays put; without it, every task moves entirely. A due date is never moved before its
 * task's start date.
 */
export function planShift(tasks: GanttTask[], reference: number, delta: number, futureOnly: boolean): ShiftedTask[] {
  if (delta === 0) return [];
  const shifted: ShiftedTask[] = [];
  for (const task of tasks) {
    const start = task.start_date ? toDay(task.start_date) : null;
    const end = task.end_date ? toDay(task.end_date) : null;
    const first = start ?? end;
    if (first === null) continue;
    const change: GanttDateChange = { id: task.id };
    if (!futureOnly || first >= reference) {
      if (start !== null) change.start_date = fromDay(start + delta);
      if (end !== null) change.end_date = fromDay(end + delta);
      shifted.push({ task, change, dueOnly: false });
    } else if (end !== null && end >= reference) {
      change.end_date = fromDay(Math.max(end + delta, start ?? -Infinity));
      if (change.end_date !== task.end_date) shifted.push({ task, change, dueOnly: true });
    }
  }
  return shifted;
}

type Mode = "by" | "to";

/**
 * Shifts the plan from the date the chart's cursor is locked on (`reference`): by a number of days forward or
 * backward, or so that the reference date lands on another date (today, say). Previews the tasks it moves.
 */
export default function GanttShiftDialog({
  reference,
  tasks,
  selectedIds,
  onApply,
  onClose,
}: {
  reference: number;
  /** Every task on the chart. */
  tasks: GanttTask[];
  /** The chart's selected tasks, which the shift can be limited to. */
  selectedIds: ReadonlySet<number>;
  onApply: (shifted: ShiftedTask[], delta: number) => void;
  onClose: () => void;
}) {
  const today = todayDay();
  const [mode, setMode] = useState<Mode>("by");
  const [days, setDays] = useState("7");
  const [forward, setForward] = useState(true);
  const [target, setTarget] = useState(fromDay(Math.max(today, reference + 7)));
  const [futureOnly, setFutureOnly] = useState(true);
  const selectedCount = tasks.filter((t) => selectedIds.has(t.id)).length;
  const [onlySelected, setOnlySelected] = useState(false);

  const count = Math.floor(Number(days));
  const validDays = days.trim() !== "" && Number.isFinite(count) && count >= 0;
  const delta = mode === "by" ? (validDays ? (forward ? count : -count) : 0) : target ? toDay(target) - reference : 0;
  const scope = onlySelected && selectedCount > 0 ? tasks.filter((t) => selectedIds.has(t.id)) : tasks;
  const shifted = planShift(scope, reference, delta, futureOnly);
  const dueOnly = shifted.filter((s) => s.dueOnly).length;
  const canApply = shifted.length > 0;

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!canApply) return;
    onApply(shifted, delta);
    onClose();
  }

  const PREVIEW = 6;
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 pt-[10vh] backdrop-blur-[1px]" onMouseDown={onClose}>
      <form
        role="dialog"
        aria-modal
        aria-labelledby="gantt-shift-title"
        onSubmit={submit}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
        }}
        className="panel flex max-h-[80vh] w-[540px] animate-dialog-in flex-col gap-4 shadow-2xl"
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 id="gantt-shift-title" className="text-base font-semibold">
              Shift the timeline
            </h2>
            <p className="mt-0.5 text-xs text-text-muted">
              From <span className="font-mono text-accent">{formatDay(reference, { weekday: true })}</span>, the date the cursor is
              locked on.
            </p>
          </div>
          <button type="button" aria-label="Close" className="rounded-md p-1 text-text-muted hover:bg-surface-hover hover:text-text-primary" onClick={onClose}>
            <svg aria-hidden width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              <path d="M3 3l8 8M11 3l-8 8" />
            </svg>
          </button>
        </div>

        <fieldset className="flex flex-col gap-2">
          <legend className="sr-only">How far to shift</legend>
          <Option checked={mode === "by"} onSelect={() => setMode("by")} label="Shift by">
            <input
              type="number"
              min={0}
              step={1}
              aria-label="Number of days"
              value={days}
              autoFocus
              onFocus={() => setMode("by")}
              onChange={(e) => setDays(e.target.value)}
              className="field w-20 py-1 text-center font-mono text-[13px]"
            />
            <span className="text-[13px] text-text-secondary">day{count === 1 ? "" : "s"}</span>
            <div role="radiogroup" aria-label="Direction" className="ml-1 flex rounded-lg border border-border-strong p-0.5">
              {[
                { value: true, label: "Forward" },
                { value: false, label: "Backward" },
              ].map((option) => (
                <button
                  key={option.label}
                  type="button"
                  role="radio"
                  aria-checked={forward === option.value}
                  onClick={() => {
                    setMode("by");
                    setForward(option.value);
                  }}
                  className={`rounded-md px-2.5 py-0.5 text-xs transition-colors ${
                    forward === option.value ? "bg-accent/[0.16] font-semibold text-accent-soft" : "text-text-secondary hover:text-text-primary"
                  }`}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </Option>
          <Option checked={mode === "to"} onSelect={() => setMode("to")} label="Shift to">
            <input
              type="date"
              aria-label="Target date"
              value={target}
              onFocus={() => setMode("to")}
              onChange={(e) => setTarget(e.target.value)}
              className="field w-40 py-1 text-[13px]"
            />
            <button
              type="button"
              className="btn min-h-0 px-2.5 py-1 text-xs"
              onClick={() => {
                setMode("to");
                setTarget(fromDay(today));
              }}
            >
              Shift to today
            </button>
          </Option>
        </fieldset>

        <div className="flex flex-col gap-2 rounded-lg border border-border-default/60 px-3 py-2.5">
          <label className="flex items-start gap-2 text-[13px]">
            <input type="checkbox" className="mt-0.5" checked={futureOnly} onChange={(e) => setFutureOnly(e.target.checked)} />
            <span>
              Shift only future dates
              <span className="block text-xs text-text-muted">
                Includes the due dates of tasks already started by {formatDay(reference)}; earlier dates stay put.
              </span>
            </span>
          </label>
          {selectedCount > 0 && (
            <label className="flex items-center gap-2 text-[13px]">
              <input type="checkbox" checked={onlySelected} onChange={(e) => setOnlySelected(e.target.checked)} />
              Only the {selectedCount} selected task{selectedCount === 1 ? "" : "s"}
            </label>
          )}
        </div>

        <section aria-label="Preview" className="flex min-h-0 flex-col gap-2">
          <p className="text-xs text-text-muted" aria-live="polite">
            {delta === 0 ? (
              "Choose how far to shift."
            ) : shifted.length === 0 ? (
              <>
                <span className="font-mono text-text-secondary">{formatDelta(delta)}</span> · no task has dates from{" "}
                {formatDay(reference)} on.
              </>
            ) : (
              <>
                <span className="font-mono text-accent">{formatDelta(delta)}</span> · {shifted.length} task{shifted.length === 1 ? "" : "s"}{" "}
                move{shifted.length === 1 ? "s" : ""}
                {dueOnly > 0 && ` (${dueOnly} only ${dueOnly === 1 ? "its" : "their"} due date)`}
              </>
            )}
          </p>
          {shifted.length > 0 && (
            <ul className="-mx-1 overflow-y-auto px-1 text-[13px]">
              {shifted.slice(0, PREVIEW).map(({ task, change, dueOnly }) => (
                <li key={task.id} className="flex items-center justify-between gap-3 border-b border-border-default/40 py-1 last:border-b-0">
                  <span className="truncate text-text-secondary" title={task.name}>
                    {task.name}
                  </span>
                  <span className="shrink-0 font-mono text-xs text-text-muted">
                    {dueOnly ? "due " : ""}
                    <span className="line-through decoration-text-muted/60">{range(dueOnly ? task.end_date : task.start_date, dueOnly ? null : task.end_date)}</span>
                    <span className="mx-1.5 text-text-muted">→</span>
                    <span className="text-text-primary">
                      {range(dueOnly ? change.end_date : (change.start_date ?? null), dueOnly ? null : (change.end_date ?? null))}
                    </span>
                  </span>
                </li>
              ))}
              {shifted.length > PREVIEW && (
                <li className="pt-1 text-xs text-text-muted">and {shifted.length - PREVIEW} more…</li>
              )}
            </ul>
          )}
        </section>

        <div className="flex justify-end gap-2 border-t border-border-default/60 pt-3">
          <button type="button" className="btn min-h-9 px-3 text-xs" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn-primary min-h-9 px-3 text-xs" disabled={!canApply}>
            {canApply ? `Shift ${shifted.length} task${shifted.length === 1 ? "" : "s"}` : "Shift"}
          </button>
        </div>
      </form>
    </div>,
    document.body,
  );
}

/** "14 Oct – 20 Oct", or one date. */
function range(start: string | null | undefined, end: string | null | undefined): string {
  const days = [start, end].filter((d): d is string => !!d).map((d) => formatDay(toDay(d)));
  return days.length === 2 && days[0] !== days[1] ? `${days[0]} – ${days[1]}` : (days[0] ?? "—");
}

/** One way of shifting: a radio button and its inputs, which pick it when used. */
function Option({ checked, onSelect, label, children }: { checked: boolean; onSelect: () => void; label: string; children: ReactNode }) {
  return (
    <div
      className={`flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2 transition-colors ${
        checked ? "border-accent/60 bg-accent/[0.06]" : "border-border-default/60 hover:border-border-strong"
      }`}
      onMouseDown={onSelect}
    >
      <label className="flex w-20 items-center gap-2 text-[13px] font-medium">
        <input type="radio" name="gantt-shift-mode" checked={checked} onChange={onSelect} />
        {label}
      </label>
      {children}
    </div>
  );
}
