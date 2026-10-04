import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { formatDay, ME, type TriageItem } from "../components/TriageBoard";
import { getJson, message } from "../lib/api";
import { useSpace } from "../lib/space";
import { projectSwatch } from "../lib/projects";

// The visible working day and its scale (the mockups use 64px per hour).
const DAY_START = 8 * 60;
const DAY_END = 18 * 60;
const HOUR_PX = 64;
const LUNCH = { start: 12 * 60, end: 13 * 60 };
const WORK_START = 9 * 60;
const CHECKIN = 17 * 60;
const TASK_MINUTES = 60;
const TRIAGE_MINUTES = 30;
const COMING_UP_MAX = 5;

const WEEKDAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

type Block = {
  key: string;
  title: string;
  start: number;
  end: number;
  detail?: string;
  project?: string | null;
  chip?: string;
  to: string;
  variant: "task" | "triage" | "checkin";
};

type Plan = { blocks: Block[]; unscheduled: number; comingUp: TriageItem[] };
type State = { state: "loading" } | { state: "ok"; items: TriageItem[] } | { state: "error"; message: string };

const isCapture = (item: TriageItem) => item.kind === "capture";

function clock(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

/** ISO 8601 week number. */
function isoWeek(date: Date): number {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
  return Math.ceil(((d.getTime() - yearStart) / 86_400_000 + 1) / 7);
}

function upperDay(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return `${WEEKDAYS[date.getUTCDay()]} ${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]}`;
}

/**
 * Lay the day out from the Morning List: half an hour to triage parked captures, then one
 * block per overdue or due-today Gantt task (claimed ones first) around lunch, and the
 * evening check-in at 17:00. Tasks claimed by someone else are left out.
 */
export function planDay(items: TriageItem[]): Plan {
  const blocks: Block[] = [];
  const captures = items.filter(isCapture).length;
  if (captures > 0) {
    blocks.push({
      key: "triage",
      title: "Triage parked items",
      start: WORK_START - TRIAGE_MINUTES,
      end: WORK_START,
      detail: `${captures} captured note${captures === 1 ? "" : "s"}`,
      to: "/triage",
      variant: "triage",
    });
  }

  const due = items.filter(
    (item) => item.kind === "gantt_task" && (item.rank === 1 || item.rank === 2) && (!item.assignee || item.assignee === ME),
  );
  // Stable sort keeps the server's order (overdue first, earliest deadline first) within each group.
  due.sort((a, b) => Number(b.assignee === ME) - Number(a.assignee === ME));

  let cursor = WORK_START;
  let scheduled = 0;
  for (const item of due) {
    if (cursor < LUNCH.end && cursor + TASK_MINUTES > LUNCH.start) cursor = LUNCH.end;
    if (cursor + TASK_MINUTES > CHECKIN) break;
    const parts = [`${clock(cursor)}–${clock(cursor + TASK_MINUTES)}`, item.project ?? "Inbox"];
    if (item.due_date) parts.push(`due ${formatDay(item.due_date)}`);
    blocks.push({
      key: item.id,
      title: item.title,
      start: cursor,
      end: cursor + TASK_MINUTES,
      detail: parts.join(" · "),
      project: item.project,
      chip: item.rank === 1 ? "Overdue" : item.status === "blocked" ? "Blocked" : item.assignee === ME ? "Claimed by you" : undefined,
      to: item.project ? `/plan/${encodeURIComponent(item.project)}` : "/triage",
      variant: "task",
    });
    cursor += TASK_MINUTES;
    scheduled++;
  }

  blocks.push({ key: "checkin", title: "Evening check-in", start: CHECKIN, end: CHECKIN + 30, to: "/check-in", variant: "checkin" });

  const comingUp = items.filter((item) => item.kind === "gantt_task" && item.rank === 5).slice(0, COMING_UP_MAX);
  return { blocks, unscheduled: due.length - scheduled, comingUp };
}

function nowMinutes(): number {
  const now = new Date();
  return now.getHours() * 60 + now.getMinutes();
}

export default function Dashboard() {
  const [triage, setTriage] = useState<State>({ state: "loading" });
  const [now, setNow] = useState(nowMinutes);
  const { spaceId } = useSpace();

  const load = useCallback((signal?: AbortSignal) => {
    setTriage({ state: "loading" });
    getJson<TriageItem[]>(`/api/triage?space_id=${spaceId}`, signal)
      .then((items) => setTriage({ state: "ok", items }))
      .catch((err: unknown) => {
        if (signal?.aborted) return;
        setTriage({ state: "error", message: message(err) });
      });
  }, [spaceId]);

  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal);
    return () => controller.abort();
  }, [load]);

  useEffect(() => {
    const timer = setInterval(() => setNow(nowMinutes()), 60_000);
    return () => clearInterval(timer);
  }, []);

  const today = new Date();
  const plan = triage.state === "ok" ? planDay(triage.items) : null;

  return (
    <div className="flex flex-col gap-5 px-9 py-7">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="font-mono text-xs tracking-[0.06em] text-text-muted">
            {WEEKDAYS[today.getDay()]} {today.getDate()} {MONTHS[today.getMonth()]} · WEEK {isoWeek(today)}
          </div>
          <h1 className="mt-1 text-[28px] font-semibold">Today</h1>
          <div className="mt-1 text-[13px] text-text-muted">
            The plan for the day, built from your tasks, the Gantt and your captured notes.
          </div>
        </div>
        <button type="button" onClick={() => load()} className="btn">
          Re-plan the day
        </button>
      </header>

      {triage.state === "error" && (
        <p className="text-sm text-text-secondary">
          Could not load the day ({triage.message}) — is the backend running on port 8000?
        </p>
      )}

      <div className="grid grid-cols-[minmax(0,1fr)_260px] items-start gap-6">
        <section className="panel px-[22px] py-4" aria-label="Schedule">
          <Timeline blocks={plan?.blocks ?? []} now={now} />
          {triage.state === "loading" && <p className="mt-3 text-[13px] text-text-muted">Loading the day…</p>}
          {plan && plan.unscheduled > 0 && (
            <p className="mt-3 text-[13px] text-text-muted">
              {plan.unscheduled} more task{plan.unscheduled === 1 ? "" : "s"} due today did not fit.{" "}
              <Link to="/triage" className="text-accent hover:underline">
                See all tasks
              </Link>
            </p>
          )}
        </section>

        <section className="panel" aria-label="Coming up">
          <h2 className="mb-2 text-base font-semibold">Coming up</h2>
          {plan && plan.comingUp.length === 0 && (
            <p className="border-t border-border-default pt-2.5 text-[13px] text-text-muted">Nothing starts this week.</p>
          )}
          {plan?.comingUp.map((item) => (
            <Link
              key={item.id}
              to={item.project ? `/plan/${encodeURIComponent(item.project)}` : "/triage"}
              className="flex flex-col gap-0.5 border-t border-border-default px-1.5 py-2.5 hover:bg-surface-hover"
            >
              <span className="font-mono text-xs text-text-muted">
                {item.start_date ? upperDay(item.start_date) : "SOON"} · {item.project ?? "INBOX"}
              </span>
              <span className="text-[13px]">{item.title}</span>
            </Link>
          ))}
        </section>
      </div>
    </div>
  );
}

const HOURS = Array.from({ length: (DAY_END - DAY_START) / 60 }, (_, i) => DAY_START + i * 60);
const y = (minutes: number) => ((minutes - DAY_START) / 60) * HOUR_PX;

function Timeline({ blocks, now }: { blocks: Block[]; now: number }) {
  return (
    <div className="flex">
      <div className="-mt-[7px] w-[52px] shrink-0 font-mono text-xs leading-none text-text-muted">
        {HOURS.map((h) => (
          <div key={h} style={{ height: HOUR_PX }}>
            {clock(h)}
          </div>
        ))}
      </div>
      <div
        className="relative flex-1 border-b border-border-default"
        style={{
          height: HOURS.length * HOUR_PX,
          backgroundImage: `repeating-linear-gradient(to bottom, #25323B 0, #25323B 1px, transparent 1px, transparent ${HOUR_PX}px)`,
        }}
      >
        {blocks.map((block) => (
          <TimelineBlock key={block.key} block={block} />
        ))}
        {now > DAY_START && now < DAY_END && (
          <div className="pointer-events-none absolute -left-1 right-0 z-10 flex items-center" style={{ top: y(now) - 3 }}>
            <span className="h-1.5 w-1.5 rounded-full bg-accent" />
            <span className="h-px flex-1 bg-accent/70" />
          </div>
        )}
      </div>
    </div>
  );
}

function TimelineBlock({ block }: { block: Block }) {
  const top = y(block.start) + 2;
  const height = y(block.end) - y(block.start) - 4;
  const short = block.end - block.start <= 30;
  const base = "absolute left-2 right-2 box-border overflow-hidden rounded-lg border px-3 hover:brightness-125";
  const look =
    block.variant === "checkin"
      ? "border-dashed border-accent bg-accent/[0.06] text-accent"
      : `text-text-primary ${projectSwatch(block.variant === "triage" ? null : block.project).block}`;

  if (short) {
    return (
      <Link
        to={block.to}
        title={block.detail}
        className={`${base} ${look} flex items-center justify-between gap-2 text-[13px] font-semibold`}
        style={{ top, height }}
      >
        <span className="truncate">{block.title}</span>
        <span className="shrink-0 font-mono text-xs font-normal">{clock(block.start)}</span>
      </Link>
    );
  }
  return (
    <Link to={block.to} className={`${base} ${look} flex flex-col gap-0.5 py-2`} style={{ top, height }}>
      <span className="flex items-center justify-between gap-2">
        <span className="truncate text-[13px] font-semibold">{block.title}</span>
        {block.chip && (
          <span className={`chip shrink-0 !py-0 !text-[11px] ${block.chip === "Overdue" ? "!border-accent/60 !text-accent" : ""}`}>
            {block.chip}
          </span>
        )}
      </span>
      {block.detail && <span className="truncate text-xs text-text-secondary">{block.detail}</span>}
    </Link>
  );
}
