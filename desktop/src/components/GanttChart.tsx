import type { ReactNode } from "react";

// Shapes returned by GET /api/gantt (see backend/schemas.py).
export type GanttTask = {
  id: number;
  name: string;
  start_date: string | null;
  end_date: string | null;
  completion_percent: number;
  status: "todo" | "in_progress" | "blocked" | "done";
  is_milestone: boolean;
};

export type GanttProject = {
  id: number;
  code: string;
  name: string;
  tasks: GanttTask[];
};

const DAY_PX = 20;
const LABEL_W = 240;
const MS_PER_DAY = 86_400_000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// Full class names so Tailwind can find them; the colours come from shared/design-tokens.json.
type Swatch = { dot: string; fill: string; track: string };
const SWATCHES: Record<string, Swatch> = {
  c7801: { dot: "bg-project-c7801", fill: "bg-project-c7801", track: "border-project-c7801 bg-project-c7801/20" },
  r5301: { dot: "bg-project-r5301", fill: "bg-project-r5301", track: "border-project-r5301 bg-project-r5301/20" },
  p5002: { dot: "bg-project-p5002", fill: "bg-project-p5002", track: "border-project-p5002 bg-project-p5002/20" },
};
const NEUTRAL: Swatch = {
  dot: "bg-project-neutral",
  fill: "bg-project-neutral",
  track: "border-project-neutral bg-project-neutral/20",
};

/** Days since the epoch for a "YYYY-MM-DD" string, independent of the local time zone. */
function toDay(iso: string): number {
  const [y, m, d] = iso.split("-").map(Number);
  return Date.UTC(y, m - 1, d) / MS_PER_DAY;
}

function todayDay(): number {
  const now = new Date();
  return Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) / MS_PER_DAY;
}

function formatDay(day: number): string {
  const date = new Date(day * MS_PER_DAY);
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]}`;
}

/** Monday on or before `day` (the epoch, day 0, was a Thursday). */
function weekStart(day: number): number {
  return day - ((day + 3) % 7);
}

type Span = { start: number; end: number };

function span(task: GanttTask): Span | null {
  const start = task.start_date ?? task.end_date;
  const end = task.end_date ?? task.start_date;
  if (!start || !end) return null;
  const [a, b] = [toDay(start), toDay(end)];
  return { start: Math.min(a, b), end: Math.max(a, b) };
}

export default function GanttChart({ projects }: { projects: GanttProject[] }) {
  const today = todayDay();
  const spans = projects.flatMap((p) => p.tasks.map(span)).filter((s): s is Span => s !== null);

  if (projects.length === 0) {
    return <p className="text-sm text-text-secondary">No projects yet. Import a Gantt with cli_import.py.</p>;
  }

  // Timeline window: whole weeks around every dated task and today, with a week of breathing room.
  const first = weekStart(Math.min(today, ...spans.map((s) => s.start)));
  const last = weekStart(Math.max(today, ...spans.map((s) => s.end))) + 14;
  const width = (last - first) * DAY_PX;
  const x = (day: number) => (day - first) * DAY_PX;
  const weeks = Array.from({ length: (last - first) / 7 }, (_, i) => first + i * 7);

  return (
    <div className="space-y-4">
      <div className="overflow-x-auto rounded-lg border border-border-default bg-surface-raised">
        <div className="relative" style={{ width: LABEL_W + width }}>
          {/* Week gridlines and the today marker, behind the rows. */}
          <div className="pointer-events-none absolute inset-y-0" style={{ left: LABEL_W, width }}>
            {weeks.map((day) => (
              <div key={day} className="absolute inset-y-0 border-l border-border-default/60" style={{ left: x(day) }} />
            ))}
            <div className="absolute inset-y-0 border-l border-dashed border-accent" style={{ left: x(today) }} />
          </div>

          <div className="flex h-10 border-b border-border-default">
            <div className="sticky left-0 z-10 shrink-0 bg-surface-raised" style={{ width: LABEL_W }} />
            <div className="relative font-mono text-xs text-text-muted" style={{ width }}>
              {weeks.map((day) => (
                <span key={day} className="absolute bottom-2 pl-1.5" style={{ left: x(day) }}>
                  {formatDay(day)}
                </span>
              ))}
              <span className="absolute top-1 pl-1 text-[10px] text-accent" style={{ left: x(today) }}>
                TODAY
              </span>
            </div>
          </div>

          {projects.map((project) => {
            const swatch = SWATCHES[project.code.toLowerCase()] ?? NEUTRAL;
            const dated = project.tasks.filter((t) => span(t) !== null);
            const milestones = dated.filter((t) => t.is_milestone);
            const bars = dated.filter((t) => !t.is_milestone);
            return (
              <div key={project.id} className="border-b border-border-default last:border-b-0">
                <Row label={<ProjectLabel project={project} dot={swatch.dot} />} width={width}>
                  {milestones.map((m) => {
                    const day = span(m)!.start;
                    return (
                      <div
                        key={m.id}
                        className="absolute top-1/2 flex -translate-y-1/2 items-center gap-1.5 whitespace-nowrap"
                        style={{ left: x(day) + DAY_PX / 2 - 6 }}
                        title={`${m.name} · ${formatDay(day)}`}
                      >
                        <span className="h-3 w-3 rotate-45 bg-accent" />
                        <span className="font-mono text-xs text-accent">
                          {m.name} · {formatDay(day)}
                        </span>
                      </div>
                    );
                  })}
                </Row>
                {bars.map((task) => (
                  <Row key={task.id} label={<span className="truncate pl-4 text-text-secondary">{task.name}</span>} width={width}>
                    <TaskBar task={task} span={span(task)!} x={x} swatch={swatch} />
                  </Row>
                ))}
                {dated.length === 0 && (
                  <Row label={<span className="pl-4 text-text-muted">No dated tasks</span>} width={width} />
                )}
              </div>
            );
          })}
        </div>
      </div>

      {projects.map((project) => (
        <Unscheduled key={project.id} project={project} />
      ))}
    </div>
  );
}

function Row({ label, width, children }: { label: ReactNode; width: number; children?: ReactNode }) {
  return (
    <div className="flex h-9 items-stretch">
      <div
        className="sticky left-0 z-10 flex shrink-0 items-center border-r border-border-default bg-surface-raised pr-3 text-sm"
        style={{ width: LABEL_W }}
      >
        {label}
      </div>
      <div className="relative" style={{ width }}>
        {children}
      </div>
    </div>
  );
}

function ProjectLabel({ project, dot }: { project: GanttProject; dot: string }) {
  return (
    <span className="flex min-w-0 items-center gap-2 pl-3 font-semibold" title={project.name}>
      <span className={`h-2 w-2 shrink-0 rounded-full ${dot}`} />
      <span>{project.code}</span>
      {project.name !== project.code && <span className="truncate font-normal text-text-muted">{project.name}</span>}
    </span>
  );
}

function TaskBar({ task, span, x, swatch }: { task: GanttTask; span: Span; x: (day: number) => number; swatch: Swatch }) {
  const percent = Math.round(task.completion_percent);
  const left = x(span.start);
  const width = (span.end - span.start + 1) * DAY_PX;
  return (
    <div
      className="absolute top-1/2 flex -translate-y-1/2 items-center gap-2 whitespace-nowrap"
      style={{ left }}
      title={`${task.name} · ${formatDay(span.start)} – ${formatDay(span.end)} · ${percent}%`}
    >
      <div className={`relative h-5 overflow-hidden rounded-md border ${swatch.track}`} style={{ width }}>
        <div className={`h-full ${swatch.fill}`} style={{ width: `${percent}%` }} />
      </div>
      <span className="font-mono text-xs text-text-muted">{percent}%</span>
    </div>
  );
}

function Unscheduled({ project }: { project: GanttProject }) {
  const undated = project.tasks.filter((t) => span(t) === null);
  if (undated.length === 0) return null;
  return (
    <details className="rounded-lg border border-border-default bg-surface-raised">
      <summary className="cursor-pointer px-5 py-3 text-sm text-text-secondary">
        {project.code}: {undated.length} task{undated.length === 1 ? "" : "s"} without dates in the imported Gantt
      </summary>
      <ul className="max-h-80 overflow-y-auto border-t border-border-default px-5 py-2 text-sm">
        {undated.map((task) => (
          <li key={task.id} className="flex justify-between gap-4 py-1">
            <span className="text-text-secondary">{task.name}</span>
            <span className="font-mono text-text-muted">{Math.round(task.completion_percent)}%</span>
          </li>
        ))}
      </ul>
    </details>
  );
}
