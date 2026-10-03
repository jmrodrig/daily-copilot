import { useEffect, useState } from "react";

// Shape returned by GET /api/triage (see TriageItem in backend/schemas.py).
export type TriageItem = {
  id: string;
  kind: "gantt_task" | "capture";
  rank: 1 | 2 | 3 | 4 | 5 | 6;
  title: string;
  project: string | null;
  priority: "low" | "normal" | "high" | "urgent";
  status: "todo" | "in_progress" | "blocked" | "done" | null;
  assignee: string | null;
  start_date: string | null;
  due_date: string | null;
  created: string | null;
  path: string | null;
  content: string | null;
};

/** The person using the app: claimed tasks are assigned to them and appear at the Evening Check-in. */
export const ME = "Jose";

export const RANK_LABELS: Record<TriageItem["rank"], string> = {
  1: "Overdue",
  2: "Today",
  3: "High priority notes",
  4: "Notes",
  5: "Coming up (7 days)",
  6: "Low priority notes",
};

const MS_PER_DAY = 86_400_000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// Full class names so Tailwind can find them; the colours come from shared/design-tokens.json.
export const PROJECT_TAG: Record<string, string> = {
  c7801: "border-project-c7801/60 text-project-c7801",
  r5301: "border-project-r5301/60 text-project-r5301",
  p5002: "border-project-p5002/60 text-project-p5002",
};
export const NEUTRAL_TAG = "border-project-neutral/60 text-text-muted";

const PRIORITY_TAG: Record<TriageItem["priority"], string> = {
  urgent: "border-accent bg-accent/15 text-accent",
  high: "border-accent/60 text-accent",
  normal: "border-border-light text-text-secondary",
  low: "border-border-default text-text-muted",
};

type State = { state: "loading" } | { state: "ok"; items: TriageItem[] } | { state: "error"; message: string };

/** Days since the epoch for a "YYYY-MM-DD" string, independent of the local time zone. */
function toDay(iso: string): number {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  return Date.UTC(y, m - 1, d) / MS_PER_DAY;
}

function todayDay(): number {
  const now = new Date();
  return Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) / MS_PER_DAY;
}

export function formatDay(iso: string): string {
  const date = new Date(toDay(iso) * MS_PER_DAY);
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]}`;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** Short schedule note for the right-hand side of a row. */
function when(item: TriageItem, today: number): string {
  if (item.kind === "capture") return item.created ? `Captured ${formatDay(item.created)}` : "Captured";
  if (item.rank === 1 && item.due_date) {
    return `Due ${formatDay(item.due_date)} · ${plural(today - toDay(item.due_date), "day")} late`;
  }
  if (item.rank === 5 && item.start_date) {
    return `Starts ${formatDay(item.start_date)} · in ${plural(toDay(item.start_date) - today, "day")}`;
  }
  return item.due_date ? `Due ${formatDay(item.due_date)}` : "No end date";
}

export default function TriageBoard() {
  const [triage, setTriage] = useState<State>({ state: "loading" });

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/triage", { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const items: TriageItem[] = await res.json();
        setTriage({ state: "ok", items });
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setTriage({ state: "error", message: err instanceof Error ? err.message : String(err) });
      });
    return () => controller.abort();
  }, []);

  const replaceItem = (updated: TriageItem) =>
    setTriage((prev) =>
      prev.state === "ok" ? { ...prev, items: prev.items.map((i) => (i.id === updated.id ? updated : i)) } : prev,
    );

  if (triage.state === "loading") return <p className="text-sm text-text-secondary">Loading /api/triage…</p>;
  if (triage.state === "error") {
    return <p className="text-sm text-text-secondary">Could not load the Morning List ({triage.message}).</p>;
  }
  if (triage.items.length === 0) {
    return (
      <p className="rounded-lg border border-border-default bg-surface-raised p-5 text-sm text-text-secondary">
        Nothing on the list today: no active Gantt tasks and no captured notes.
      </p>
    );
  }

  const today = todayDay();
  // Items arrive sorted by rank, so grouping preserves the server's order.
  const groups = new Map<TriageItem["rank"], TriageItem[]>();
  for (const item of triage.items) groups.set(item.rank, [...(groups.get(item.rank) ?? []), item]);

  return (
    <div className="divide-y divide-border-default overflow-hidden rounded-lg border border-border-default bg-surface-raised">
      {[...groups].map(([rank, items]) => (
        <div key={rank}>
          <h3
            className={`flex items-center justify-between bg-surface-panel px-5 py-2 text-xs font-medium uppercase tracking-wider ${
              rank === 1 ? "text-accent" : "text-text-muted"
            }`}
          >
            <span>{RANK_LABELS[rank]}</span>
            <span className="font-mono">{items.length}</span>
          </h3>
          <ul className="divide-y divide-border-default/60">
            {items.map((item) => (
              <TriageRow key={item.id} item={item} today={today} onChange={replaceItem} />
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

function TriageRow({
  item,
  today,
  onChange,
}: {
  item: TriageItem;
  today: number;
  onChange: (item: TriageItem) => void;
}) {
  const isTask = item.kind === "gantt_task";
  // The note body beyond its first line (which is already the title).
  const detail = item.content?.trim().split(/\r?\n/).slice(1).join(" ").trim();
  return (
    <li className="flex items-start gap-3 px-5 py-3">
      <KindBadge isTask={isTask} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className={`text-sm ${isTask ? "font-medium text-text-primary" : "text-text-secondary"}`}>
            {item.title}
          </span>
          <Tag className={item.project ? PROJECT_TAG[item.project.toLowerCase()] ?? NEUTRAL_TAG : NEUTRAL_TAG}>
            {item.project ?? "Inbox"}
          </Tag>
          {(!isTask || item.priority !== "normal") && (
            <Tag className={PRIORITY_TAG[item.priority]}>{item.priority}</Tag>
          )}
          {item.status === "blocked" && <Tag className={PRIORITY_TAG.urgent}>blocked</Tag>}
        </div>
        {detail && <p className="mt-1 truncate text-xs text-text-muted">{detail}</p>}
      </div>
      <span
        className={`shrink-0 pt-0.5 font-mono text-xs ${item.rank === 1 ? "text-accent" : "text-text-muted"}`}
        title={item.path ?? undefined}
      >
        {when(item, today)}
      </span>
      {isTask && <ClaimButton item={item} onChange={onChange} />}
    </li>
  );
}

/** "Claim" an unassigned Gantt task (assign it to ME and start it); click a claimed task's badge to unclaim it. */
function ClaimButton({ item, onChange }: { item: TriageItem; onChange: (item: TriageItem) => void }) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mine = item.assignee === ME;

  async function patch(body: { assignee: string | null; status?: "in_progress" }) {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/tasks/${item.id.slice("task:".length)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const task: { assignee: string | null; status: NonNullable<TriageItem["status"]> } = await res.json();
      onChange({ ...item, assignee: task.assignee, status: task.status });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  if (item.assignee && !mine) {
    return <span className="w-16 shrink-0 pt-0.5 text-right text-xs text-text-muted">👤 {item.assignee}</span>;
  }
  return (
    <button
      type="button"
      disabled={saving}
      onClick={() =>
        patch(mine ? { assignee: null } : { assignee: ME, ...(item.status === "todo" ? { status: "in_progress" } : {}) })
      }
      title={error ? `Could not update the task (${error})` : mine ? "Claimed by you · click to unclaim" : "Claim this task"}
      className={`w-16 shrink-0 rounded border px-1.5 py-px text-xs disabled:opacity-40 ${
        error
          ? "border-accent/60 text-accent"
          : mine
            ? "border-accent/60 bg-accent/15 text-accent hover:bg-accent/25"
            : "border-border-default text-text-muted hover:border-border-light hover:text-text-primary"
      }`}
    >
      {error ? "Retry" : mine ? `👤 ${ME}` : "Claim"}
    </button>
  );
}

/** Gantt tasks get a solid bar like the chart; ad-hoc notes get an outlined, dog-eared page. */
function KindBadge({ isTask }: { isTask: boolean }) {
  return isTask ? (
    <span className="mt-0.5 flex w-12 shrink-0 items-center gap-1.5" title="Gantt task">
      <span className="h-2 w-3 rounded-sm bg-text-secondary" />
      <span className="font-mono text-[10px] uppercase text-text-muted">Task</span>
    </span>
  ) : (
    <span className="mt-0.5 flex w-12 shrink-0 items-center gap-1.5" title="Captured note">
      <span className="h-3 w-2.5 rounded-sm rounded-tr-none border border-dashed border-text-muted" />
      <span className="font-mono text-[10px] uppercase text-text-muted">Note</span>
    </span>
  );
}

export function Tag({ className, children }: { className: string; children: string }) {
  return (
    <span className={`rounded border px-1.5 py-px font-mono text-[10px] uppercase leading-4 ${className}`}>
      {children}
    </span>
  );
}
