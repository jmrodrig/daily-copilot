import { useState, type CSSProperties, type ReactNode } from "react";

import { tint, type HexColor } from "../lib/colors";
import type { CustomFieldDef } from "../lib/space";

// Shapes returned by GET /api/gantt (see backend/schemas.py).
export type GanttTask = {
  id: number;
  name: string;
  start_date: string | null;
  end_date: string | null;
  completion_percent: number;
  status: "backlog" | "todo" | "in_progress" | "blocked" | "done" | "archived";
  is_milestone: boolean;
  /** The task's custom field values, for colouring its bar by a dropdown field. */
  custom_fields?: Record<string, unknown>;
};

export type GanttProject = {
  id: number;
  code: string;
  name: string;
  /** "#rrggbb"; null falls back to the project's built-in swatch. */
  color?: string | null;
  tasks: GanttTask[];
};

const DAY_PX = 20;
const LABEL_W = 240;
const MS_PER_DAY = 86_400_000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** A class and/or inline style: built-in swatches are Tailwind classes, colours set by the user are inline. */
type Paint = { className: string; style?: CSSProperties };
type Swatch = { dot: Paint; fill: Paint; track: Paint };

// Full class names so Tailwind can find them; the colours come from shared/design-tokens.json.
const SWATCHES: Record<string, Swatch> = {
  c7801: {
    dot: { className: "bg-project-c7801" },
    fill: { className: "bg-project-c7801" },
    track: { className: "border-project-c7801 bg-project-c7801/20" },
  },
  r5301: {
    dot: { className: "bg-project-r5301" },
    fill: { className: "bg-project-r5301" },
    track: { className: "border-project-r5301 bg-project-r5301/20" },
  },
  p5002: {
    dot: { className: "bg-project-p5002" },
    fill: { className: "bg-project-p5002" },
    track: { className: "border-project-p5002 bg-project-p5002/20" },
  },
};
const NEUTRAL: Swatch = {
  dot: { className: "bg-project-neutral" },
  fill: { className: "bg-project-neutral" },
  track: { className: "border-project-neutral bg-project-neutral/20" },
};

function hexSwatch(color: HexColor): Swatch {
  return {
    dot: { className: "", style: { backgroundColor: color } },
    fill: { className: "", style: { backgroundColor: color } },
    track: { className: "", style: { borderColor: color, backgroundColor: tint(color, 0.2) } },
  };
}

/** A project's swatch: its own colour if set, else the built-in one for its code, else neutral. */
function projectSwatch(project: GanttProject): Swatch {
  if (project.color) return hexSwatch(project.color);
  return SWATCHES[project.code.toLowerCase()] ?? NEUTRAL;
}

/** Bars are coloured by their project, or by the option a task holds in one of the space's dropdown fields. */
const BY_PROJECT = "project";

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

/** Clicking a task opens it (in the task panel) when `onTaskClick` is given; `activeTaskId` is highlighted. */
type TaskClick = { onTaskClick?: (id: number) => void; activeTaskId?: number | null };

/**
 * `customFields` are the space's custom fields: when some are dropdowns, a "Colour by" control offers to colour the
 * bars by the option each task holds (options without a colour, and tasks without a value, are neutral). The choice is
 * kept by the chart unless `onColorBy` is given, in which case `colorBy` (a field id, or null for by project) is it.
 */
export default function GanttChart({
  projects,
  customFields = [],
  colorBy: controlledColorBy,
  onColorBy,
  onTaskClick,
  activeTaskId = null,
}: {
  projects: GanttProject[];
  customFields?: CustomFieldDef[];
  colorBy?: string | null;
  onColorBy?: (fieldId: string | null) => void;
} & TaskClick) {
  const today = todayDay();
  const spans = projects.flatMap((p) => p.tasks.map(span)).filter((s): s is Span => s !== null);
  const dropdowns = customFields.filter((f) => f.type === "dropdown");
  const [ownColorBy, setOwnColorBy] = useState(BY_PROJECT);
  const colorBy = onColorBy ? (controlledColorBy ?? BY_PROJECT) : ownColorBy;
  const setColorBy = (value: string) => (onColorBy ? onColorBy(value === BY_PROJECT ? null : value) : setOwnColorBy(value));
  // A field removed since it was picked goes back to the project colours.
  const colorField = dropdowns.find((f) => f.id === colorBy) ?? null;

  if (projects.length === 0) {
    return <p className="text-sm text-text-secondary">No projects yet. Import a Gantt with cli_import.py.</p>;
  }

  const barSwatch = (project: GanttProject, task: GanttTask): Swatch => {
    if (!colorField) return projectSwatch(project);
    const value = task.custom_fields?.[colorField.id];
    const color = typeof value === "string" ? colorField.colors?.[value] : undefined;
    return color ? hexSwatch(color) : NEUTRAL;
  };

  // Timeline window: whole weeks around every dated task and today, with a week of breathing room.
  const first = weekStart(Math.min(today, ...spans.map((s) => s.start)));
  const last = weekStart(Math.max(today, ...spans.map((s) => s.end))) + 14;
  const width = (last - first) * DAY_PX;
  const x = (day: number) => (day - first) * DAY_PX;
  const weeks = Array.from({ length: (last - first) / 7 }, (_, i) => first + i * 7);

  return (
    <div className="space-y-4">
      {dropdowns.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-text-muted">
          <label className="flex items-center gap-1.5">
            Colour by
            <select value={colorField?.id ?? BY_PROJECT} onChange={(e) => setColorBy(e.target.value)} className="field w-auto py-1 text-[13px]">
              <option value={BY_PROJECT}>Project</option>
              {dropdowns.map((field) => (
                <option key={field.id} value={field.id}>
                  {field.name}
                </option>
              ))}
            </select>
          </label>
          {colorField && <Legend field={colorField} />}
        </div>
      )}
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
              <span className="absolute top-1 pl-1 text-[12px] text-accent" style={{ left: x(today) }}>
                TODAY
              </span>
            </div>
          </div>

          {projects.map((project) => {
            const swatch = projectSwatch(project);
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
                        className={`absolute top-1/2 flex -translate-y-1/2 items-center gap-1.5 whitespace-nowrap ${
                          onTaskClick ? "cursor-pointer hover:underline" : ""
                        } ${m.id === activeTaskId ? "underline" : ""}`}
                        style={{ left: x(day) + DAY_PX / 2 - 6 }}
                        title={`${m.name} · ${formatDay(day)}`}
                        onClick={onTaskClick && (() => onTaskClick(m.id))}
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
                  <Row
                    key={task.id}
                    label={<TaskLabel task={task} onTaskClick={onTaskClick} activeTaskId={activeTaskId} />}
                    width={width}
                    active={task.id === activeTaskId}
                  >
                    <TaskBar task={task} span={span(task)!} x={x} swatch={barSwatch(project, task)} onClick={onTaskClick && (() => onTaskClick(task.id))} />
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
        <Unscheduled key={project.id} project={project} onTaskClick={onTaskClick} activeTaskId={activeTaskId} />
      ))}
    </div>
  );
}

function Row({ label, width, active, children }: { label: ReactNode; width: number; active?: boolean; children?: ReactNode }) {
  return (
    <div className={`flex h-9 items-stretch ${active ? "bg-surface-active" : ""}`}>
      <div
        className={`sticky left-0 z-10 flex shrink-0 items-center border-r border-border-default pr-3 text-sm ${
          active ? "bg-surface-active" : "bg-surface-raised"
        }`}
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

/** The colours of a dropdown field's options, when the bars are coloured by it. */
function Legend({ field }: { field: CustomFieldDef }) {
  const chip = "h-2.5 w-2.5 rounded-sm";
  return (
    <ul aria-label={`${field.name} colours`} className="flex flex-wrap items-center gap-x-3 gap-y-1">
      {field.options.map((option) => {
        const color = field.colors?.[option];
        return (
          <li key={option} className="flex items-center gap-1.5">
            <span className={`${chip} ${color ? "" : NEUTRAL.fill.className}`} style={color ? { backgroundColor: color } : undefined} />
            {option}
          </li>
        );
      })}
      <li className="flex items-center gap-1.5">
        <span className={`${chip} ${NEUTRAL.fill.className}`} />
        No value
      </li>
    </ul>
  );
}

function ProjectLabel({ project, dot }: { project: GanttProject; dot: Paint }) {
  return (
    <span className="flex min-w-0 items-center gap-2 pl-3 font-semibold" title={project.name}>
      <span className={`h-2 w-2 shrink-0 rounded-full ${dot.className}`} style={dot.style} />
      <span>{project.code}</span>
      {project.name !== project.code && <span className="truncate font-normal text-text-muted">{project.name}</span>}
    </span>
  );
}

function TaskLabel({ task, onTaskClick, activeTaskId }: { task: GanttTask } & TaskClick) {
  if (!onTaskClick) return <span className="truncate pl-4 text-text-secondary">{task.name}</span>;
  return (
    <button
      type="button"
      onClick={() => onTaskClick(task.id)}
      title="Open task details"
      aria-current={task.id === activeTaskId || undefined}
      className={`truncate pl-4 text-left hover:underline ${task.id === activeTaskId ? "text-text-primary" : "text-text-secondary"}`}
    >
      {task.name}
    </button>
  );
}

function TaskBar({
  task,
  span,
  x,
  swatch,
  onClick,
}: {
  task: GanttTask;
  span: Span;
  x: (day: number) => number;
  swatch: Swatch;
  onClick?: () => void;
}) {
  const percent = Math.round(task.completion_percent);
  const left = x(span.start);
  const width = (span.end - span.start + 1) * DAY_PX;
  return (
    <div
      className={`absolute top-1/2 flex -translate-y-1/2 items-center gap-2 whitespace-nowrap ${onClick ? "cursor-pointer" : ""}`}
      style={{ left }}
      title={`${task.name} · ${formatDay(span.start)} – ${formatDay(span.end)} · ${percent}%`}
      onClick={onClick}
    >
      {/* The completed part is left hollow (the track shows through); the work still to do is filled. */}
      <div className={`relative flex h-5 overflow-hidden rounded-md border ${swatch.track.className}`} style={{ ...swatch.track.style, width }}>
        <div className="h-full shrink-0" style={{ width: `${percent}%` }} />
        <div className={`h-full flex-1 ${swatch.fill.className}`} style={swatch.fill.style} />
      </div>
      <span className="font-mono text-xs text-text-muted">{percent}%</span>
    </div>
  );
}

function Unscheduled({ project, onTaskClick, activeTaskId }: { project: GanttProject } & TaskClick) {
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
            {onTaskClick ? (
              <button
                type="button"
                onClick={() => onTaskClick(task.id)}
                className={`text-left hover:underline ${task.id === activeTaskId ? "text-text-primary" : "text-text-secondary"}`}
              >
                {task.name}
              </button>
            ) : (
              <span className="text-text-secondary">{task.name}</span>
            )}
            <span className="font-mono text-text-muted">{Math.round(task.completion_percent)}%</span>
          </li>
        ))}
      </ul>
    </details>
  );
}
