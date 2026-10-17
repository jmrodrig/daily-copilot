import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

import { message } from "../lib/api";
import { tint, type HexColor } from "../lib/colors";
import { formatDay, formatDelta, fromDay, isWeekend, toDay, todayDay } from "../lib/days";
import type { CustomFieldDef } from "../lib/space";
import { createTaskLink, deleteTaskLink, fetchSpaceLinks, useLinksChanged, type LinkWithDetails } from "../lib/tasks";
import GanttShiftDialog, { type ShiftedTask } from "./GanttShiftDialog";

// Shapes returned by GET /api/gantt (see backend/schemas.py).
export type GanttTask = {
  id: number;
  name: string;
  start_date: string | null;
  end_date: string | null;
  completion_percent: number;
  status: "backlog" | "todo" | "in_progress" | "in_review" | "blocked" | "done" | "archived";
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

/** A task's new dates from the chart ("YYYY-MM-DD"); a field left out is unchanged, `null` clears it. */
export type GanttDateChange = { id: number; start_date?: string | null; end_date?: string | null };

const DAY_PX = 20;
// Heights of the header and of each row (`h-10`, `h-9`): the dependency arrows are placed from them.
const HEADER_H = 40;
const ROW_H = 36;
// The task labels column: its default width, and how narrow or wide it can be dragged.
const LABEL_DEFAULT_W = 240;
const LABEL_MIN_W = 150;
const LABEL_MAX_W = 800;
// How much of the timeline stays in view, however wide the labels are dragged.
const TIMELINE_MIN_W = 120;
// Bars narrower than this many pixels are dragged whole; their edges are too small to grab.
const HANDLE_PX = 6;
// A press that moves less than this is a click, not a drag.
const DRAG_THRESHOLD_PX = 3;
const UNDO_MS = 8000;
const LINK_ERROR_MS = 6000;

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

/** What dragging a bar changes: its left edge (start date), its right edge (due date), or both (moving it). */
type DragMode = "move" | "start" | "end";

/** A drag in progress: the bars it moves and by how many days (`moved` once past the click threshold). */
type Drag = { mode: DragMode; originId: number; ids: number[]; delta: number; moved: boolean };

/** `span` with a drag of `delta` days applied; a resized bar keeps at least one day. */
function dragSpan(base: Span, mode: DragMode, delta: number): Span {
  if (mode === "move") return { start: base.start + delta, end: base.end + delta };
  if (mode === "start") return { start: Math.min(base.start + delta, base.end), end: base.end };
  return { start: base.start, end: Math.max(base.end + delta, base.start) };
}

/**
 * The task's new dates after a drag. Moving shifts the dates it has; resizing sets the dragged edge and pins the
 * other one, so a task with only one date gets both.
 */
function dragChange(task: GanttTask, mode: DragMode, delta: number): GanttDateChange | null {
  const base = span(task);
  if (!base || delta === 0) return null;
  const next = dragSpan(base, mode, delta);
  const change: GanttDateChange = { id: task.id };
  if (mode === "move") {
    if (task.start_date) change.start_date = fromDay(toDay(task.start_date) + delta);
    if (task.end_date) change.end_date = fromDay(toDay(task.end_date) + delta);
  } else {
    change.start_date = fromDay(next.start);
    change.end_date = fromDay(next.end);
  }
  const same = (change.start_date ?? task.start_date) === task.start_date && (change.end_date ?? task.end_date) === task.end_date;
  return same ? null : change;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Clicking a task opens it (in the task panel) when `onTaskClick` is given; `activeTaskId` is highlighted. */
type TaskClick = { onTaskClick?: (id: number) => void; activeTaskId?: number | null };

/** A click's modifier keys: Ctrl/⌘ toggles a task in the selection, Shift selects a range. */
type Modifiers = { toggle: boolean; range: boolean };
const modifiers = (e: ReactMouseEvent | ReactPointerEvent): Modifiers => ({ toggle: e.ctrlKey || e.metaKey, range: e.shiftKey });

/** The latest change made on the chart, offered for undoing (`inverse` puts the old dates back). */
type Toast = { label: string; inverse: GanttDateChange[] | null; saving: boolean };

/**
 * `customFields` are the space's custom fields: when some are dropdowns, a "Colour by" control offers to colour the
 * bars by the option each task holds (options without a colour, and tasks without a value, are neutral). The choice is
 * kept by the chart unless `onColorBy` is given, in which case `colorBy` (a field id, or null for by project) is it.
 *
 * With `onReschedule` the chart is editable: tasks can be selected (checkboxes, Ctrl/⌘-click, Shift-click), dragged
 * to new dates or resized by their edges (all selected tasks move together), and the whole plan can be shifted from
 * a date picked with the grid cursor. `onReschedule` should show the new dates at once and reject if saving fails.
 *
 * With `spaceId` the chart draws the space's task dependencies as arrows (amber, with a caution triangle, where the
 * dates contradict them); clicking one shows it and, when editable, offers to delete it. An editable chart also gets a
 * connector on each bar's right end: drag it onto another task, or click it and then the task, to make that task wait
 * on this one.
 */
export default function GanttChart({
  projects,
  customFields = [],
  colorBy: controlledColorBy,
  onColorBy,
  onTaskClick,
  activeTaskId = null,
  onReschedule,
  spaceId,
}: {
  projects: GanttProject[];
  spaceId?: number;
  customFields?: CustomFieldDef[];
  colorBy?: string | null;
  onColorBy?: (fieldId: string | null) => void;
  onReschedule?: (changes: GanttDateChange[]) => Promise<void> | void;
} & TaskClick) {
  const editable = !!onReschedule;
  const today = todayDay();
  const dropdowns = customFields.filter((f) => f.type === "dropdown");
  const [ownColorBy, setOwnColorBy] = useState(BY_PROJECT);
  const colorBy = onColorBy ? (controlledColorBy ?? BY_PROJECT) : ownColorBy;
  const setColorBy = (value: string) => (onColorBy ? onColorBy(value === BY_PROJECT ? null : value) : setOwnColorBy(value));
  // A field removed since it was picked goes back to the project colours.
  const colorField = dropdowns.find((f) => f.id === colorBy) ?? null;

  const allTasks = useMemo(() => projects.flatMap((p) => p.tasks), [projects]);
  const taskById = useMemo(() => new Map(allTasks.map((t) => [t.id, t])), [allTasks]);
  // Dated tasks top to bottom, as Shift-click ranges run: each project's milestones, then its bars.
  const order = useMemo(
    () =>
      projects.flatMap((p) => {
        const dated = p.tasks.filter((t) => span(t) !== null);
        return [...dated.filter((t) => t.is_milestone), ...dated.filter((t) => !t.is_milestone)].map((t) => t.id);
      }),
    [projects],
  );

  // --- Selection ---
  const [selected, setSelected] = useState<ReadonlySet<number>>(new Set());
  const anchor = useRef<number | null>(null);
  // Tasks that left the chart (filtered out, deleted) leave the selection.
  useEffect(() => {
    setSelected((prev) => {
      const kept = [...prev].filter((id) => taskById.has(id));
      return kept.length === prev.size ? prev : new Set(kept);
    });
  }, [taskById]);

  const setMany = (ids: number[], on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      ids.forEach((id) => (on ? next.add(id) : next.delete(id)));
      return next;
    });

  const chartRef = useRef<HTMLDivElement>(null);

  // --- Dependencies ---
  const linkable = editable && spaceId !== undefined;
  const [links, setLinks] = useState<LinkWithDetails[]>([]);
  const [linksVersion, setLinksVersion] = useState(0);
  useLinksChanged(() => setLinksVersion((v) => v + 1));
  useEffect(() => {
    if (spaceId === undefined) return setLinks([]);
    const controller = new AbortController();
    fetchSpaceLinks(spaceId, controller.signal)
      .then(setLinks)
      .catch(() => {});
    return () => controller.abort();
  }, [spaceId, linksVersion]);
  // Linking: the task the new dependency starts from, and the pointer (in the arrows' coordinates) for the rubber band.
  const [linking, setLinking] = useState<{ from: number; pointer: { x: number; y: number } | null } | null>(null);
  const [linkError, setLinkError] = useState<string | null>(null);
  const [openLink, setOpenLink] = useState<{ id: number; x: number; y: number } | null>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!linkError) return;
    const timer = window.setTimeout(() => setLinkError(null), LINK_ERROR_MS);
    return () => window.clearTimeout(timer);
  }, [linkError]);

  /** Makes `to` wait on `from` (the arrows reload when the link is saved). */
  async function link(from: number, to: number) {
    setLinking(null);
    if (from === to) return;
    setLinkError(null);
    try {
      await createTaskLink(from, to);
    } catch (err: unknown) {
      setLinkError(`Could not link the tasks: ${message(err)}`);
    }
  }

  /** A client point in the arrows' coordinates (the timeline, under the labels column). */
  const linkPoint = (clientX: number, clientY: number) => {
    const rect = contentRef.current?.getBoundingClientRect();
    return rect ? { x: clientX - rect.left - labelW, y: clientY - rect.top } : null;
  };

  /** The task whose bar, milestone or row is under a client point. */
  const taskAt = (clientX: number, clientY: number): number | null => {
    const el = document.elementFromPoint(clientX, clientY)?.closest<HTMLElement>("[data-gantt-task], [data-task-row]");
    const id = Number(el?.dataset.ganttTask ?? el?.dataset.taskRow);
    return Number.isFinite(id) && id > 0 ? id : null;
  };

  /** Pressing a bar's connector: drag it onto another task to link them, or let go to pick the task with a click. */
  function beginLink(e: ReactPointerEvent, task: GanttTask) {
    if (!linkable || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const [startX, startY] = [e.clientX, e.clientY];
    let moved = false;
    setOpenLink(null);
    setHoverDay(null);
    setLinking({ from: task.id, pointer: linkPoint(e.clientX, e.clientY) });
    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== e.pointerId) return;
      moved ||= Math.hypot(ev.clientX - startX, ev.clientY - startY) > DRAG_THRESHOLD_PX;
      const pointer = linkPoint(ev.clientX, ev.clientY);
      setLinking((current) => current && { ...current, pointer });
    };
    const onUp = (ev: PointerEvent) => {
      if (ev.pointerId !== e.pointerId) return;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      // A click on the connector stays in linking mode, waiting for the task to be clicked.
      if (!moved || ev.type === "pointercancel") {
        if (ev.type === "pointercancel") setLinking(null);
        return;
      }
      suppressClick.current = true;
      window.setTimeout(() => (suppressClick.current = false), 0);
      const target = taskAt(ev.clientX, ev.clientY);
      if (target !== null && target !== task.id) void link(task.id, target);
      else setLinking(null);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  }

  // While linking, a press outside the chart gives up.
  useEffect(() => {
    if (!linking) return;
    const onDown = (e: PointerEvent) => {
      if (!chartRef.current?.contains(e.target as Node)) setLinking(null);
    };
    window.addEventListener("pointerdown", onDown, true);
    return () => window.removeEventListener("pointerdown", onDown, true);
  }, [linking !== null]);

  /** A click on a task's row, label or bar: select with Ctrl/⌘ or Shift, else open it (or, while linking, link it). */
  function clickTask(id: number, { toggle, range }: Modifiers) {
    if (linking) {
      void link(linking.from, id);
      return;
    }
    if (editable && range && anchor.current !== null && order.includes(anchor.current) && order.includes(id)) {
      const [a, b] = [order.indexOf(anchor.current), order.indexOf(id)].sort((x, y) => x - y);
      const ids = order.slice(a, b + 1);
      setSelected((prev) => new Set(toggle ? [...prev, ...ids] : ids));
      return;
    }
    if (editable && (toggle || range)) {
      setSelected((prev) => {
        const next = new Set(prev);
        if (!next.delete(id)) next.add(id);
        return next;
      });
      anchor.current = id;
      return;
    }
    anchor.current = id;
    if (selected.size > 0) setSelected(new Set());
    onTaskClick?.(id);
  }

  /** A task's checkbox: toggles it, or with Shift the range from the last task clicked. */
  function checkTask(id: number, e: ReactMouseEvent) {
    clickTask(id, { toggle: !e.shiftKey, range: e.shiftKey });
  }

  // --- Saving, with undo ---
  const [toast, setToast] = useState<Toast | null>(null);
  useEffect(() => {
    if (!toast || toast.saving) return;
    const timer = window.setTimeout(() => setToast(null), UNDO_MS);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const save = useCallback(
    (changes: GanttDateChange[], label: string, undoable = true) => {
      if (!onReschedule || changes.length === 0) return;
      const inverse = changes.map((change) => {
        const task = taskById.get(change.id)!;
        const back: GanttDateChange = { id: change.id };
        if ("start_date" in change) back.start_date = task.start_date;
        if ("end_date" in change) back.end_date = task.end_date;
        return back;
      });
      const token = { label, inverse: undoable ? inverse : null, saving: true };
      setToast(token);
      Promise.resolve(onReschedule(changes)).then(
        () => setToast((current) => (current === token ? { ...token, saving: false } : current)),
        () => setToast((current) => (current === token ? null : current)),
      );
    },
    [onReschedule, taskById],
  );

  const undo = useCallback(() => {
    if (!toast?.inverse || toast.saving) return;
    save(toast.inverse, "Change undone", false);
  }, [toast, save]);

  // --- Grid cursor and timeline shifting ---
  const [hoverDay, setHoverDay] = useState<number | null>(null);
  // The day the shift dialog was opened from, while it is open.
  const [shiftAnchor, setShiftAnchor] = useState<number | null>(null);

  // --- Dragging bars ---
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [labelW, setLabelW] = useState(LABEL_DEFAULT_W);
  const [drag, setDrag] = useState<Drag | null>(null);
  // Set after a drag ends, so the click that follows the release doesn't open the task.
  const suppressClick = useRef(false);

  function beginDrag(e: ReactPointerEvent, task: GanttTask, mode: DragMode) {
    const scroller = scrollerRef.current;
    if (!editable || !scroller || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey) return;
    e.preventDefault();
    e.stopPropagation();
    const ids =
      selected.has(task.id) && selected.size > 1 ? [...selected].filter((id) => taskById.has(id) && span(taskById.get(id)!)) : [task.id];
    const startX = e.clientX;
    const startScroll = scroller.scrollLeft;
    let lastX = startX;
    let current: Drag = { mode, originId: task.id, ids, delta: 0, moved: false };
    suppressClick.current = false;
    setDrag(current);
    setHoverDay(null);

    const update = () => {
      const px = lastX - startX + scroller.scrollLeft - startScroll;
      const moved = current.moved || Math.abs(px) > DRAG_THRESHOLD_PX;
      const delta = moved ? Math.round(px / DAY_PX) : 0;
      if (moved !== current.moved || delta !== current.delta) {
        current = { ...current, moved, delta };
        setDrag(current);
      }
    };
    // Dragged towards one of the chart's edges, the timeline scrolls, faster the closer the pointer gets to it.
    let frame = 0;
    const autoScroll = () => {
      if (current.moved) {
        const rect = scroller.getBoundingClientRect();
        const edge = 56;
        const right = lastX > startX ? lastX - (rect.right - edge) : 0;
        const left = lastX < startX ? rect.left + labelW + edge - lastX : 0;
        const speed = right > 0 ? Math.min(1, right / edge) : left > 0 ? -Math.min(1, left / edge) : 0;
        if (speed !== 0) {
          scroller.scrollLeft += speed * 16;
          update();
        }
      }
      frame = requestAnimationFrame(autoScroll);
    };
    frame = requestAnimationFrame(autoScroll);

    const root = document.documentElement;
    const previousCursor = root.style.cursor;
    root.style.cursor = mode === "move" ? "grabbing" : "ew-resize";
    root.style.userSelect = "none";

    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== e.pointerId) return;
      lastX = ev.clientX;
      update();
    };
    const finish = (commit: boolean) => {
      cancelAnimationFrame(frame);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("keydown", onKey, true);
      root.style.cursor = previousCursor;
      root.style.userSelect = "";
      setDrag(null);
      if (!current.moved) return;
      suppressClick.current = true;
      window.setTimeout(() => (suppressClick.current = false), 0);
      if (!commit || current.delta === 0) return;
      const changes = current.ids.map((id) => dragChange(taskById.get(id)!, mode, current.delta)).filter((c): c is GanttDateChange => c !== null);
      const what = changes.length === 1 ? `"${taskById.get(changes[0].id)!.name}"` : plural(changes.length, "task");
      const verb = mode === "move" ? "Moved" : mode === "start" ? "Changed the start of" : "Changed the due date of";
      save(changes, `${verb} ${what} · ${formatDelta(current.delta)}`);
    };
    const onUp = (ev: PointerEvent) => ev.pointerId === e.pointerId && finish(true);
    const onCancel = (ev: PointerEvent) => ev.pointerId === e.pointerId && finish(false);
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== "Escape") return;
      ev.preventDefault();
      ev.stopPropagation();
      finish(false);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    window.addEventListener("keydown", onKey, true);
  }

  // --- Resizing the labels column ---
  // While the column is dragged its width goes straight into the --gantt-label-w CSS variable, once a frame, so the
  // chart isn't re-rendered on every pointer move; the final width is set in state when the drag ends.
  const [resizing, setResizing] = useState(false);

  const clampLabelW = (w: number) => {
    const room = (scrollerRef.current?.clientWidth ?? Infinity) - TIMELINE_MIN_W;
    return Math.round(Math.max(LABEL_MIN_W, Math.min(w, LABEL_MAX_W, room)));
  };

  function beginResize(e: ReactPointerEvent) {
    const chart = chartRef.current;
    if (!chart || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startW = labelW;
    let next = startW;
    let frame = 0;
    setResizing(true);
    setHoverDay(null);

    const root = document.documentElement;
    const previousCursor = root.style.cursor;
    root.style.cursor = "col-resize";
    root.style.userSelect = "none";

    const paint = () => {
      frame = 0;
      chart.style.setProperty("--gantt-label-w", `${next}px`);
    };
    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== e.pointerId) return;
      next = clampLabelW(startW + ev.clientX - startX);
      if (!frame) frame = requestAnimationFrame(paint);
    };
    const finish = (commit: boolean) => {
      cancelAnimationFrame(frame);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("keydown", onKey, true);
      root.style.cursor = previousCursor;
      root.style.userSelect = "";
      const final = commit ? next : startW;
      chart.style.setProperty("--gantt-label-w", `${final}px`);
      setLabelW(final);
      setResizing(false);
    };
    const onUp = (ev: PointerEvent) => ev.pointerId === e.pointerId && finish(true);
    const onCancel = (ev: PointerEvent) => ev.pointerId === e.pointerId && finish(false);
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== "Escape") return;
      ev.preventDefault();
      ev.stopPropagation();
      finish(false);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    window.addEventListener("keydown", onKey, true);
  }

  /** Arrow keys on the column's resize handle widen or narrow it; Home/End take it to its narrowest or widest. */
  function resizeByKey(e: ReactKeyboardEvent) {
    const step = e.shiftKey ? 64 : 16;
    const target =
      e.key === "ArrowLeft" ? labelW - step : e.key === "ArrowRight" ? labelW + step : e.key === "Home" ? LABEL_MIN_W : e.key === "End" ? LABEL_MAX_W : null;
    if (target === null) return;
    e.preventDefault();
    setLabelW(clampLabelW(target));
  }

  /** Where a task is drawn: its dates, or where the drag in progress puts it. */
  const shown = (task: GanttTask): Span => {
    const base = span(task)!;
    return drag && drag.moved && drag.ids.includes(task.id) ? dragSpan(base, drag.mode, drag.delta) : base;
  };

  // Escape clears the selection; Ctrl/⌘+Z undoes the latest change while it's offered.
  useEffect(() => {
    if (!editable) return;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (shiftAnchor !== null || e.defaultPrevented || target?.closest("input:not([type=checkbox]):not([type=radio]), textarea, select, [contenteditable=true], [role=dialog]")) return;
      if (e.key === "Escape") {
        if (linking) setLinking(null);
        else if (selected.size > 0) setSelected(new Set());
      } else if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === "z" && toast?.inverse && !toast.saving) {
        e.preventDefault();
        undo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editable, shiftAnchor, selected, toast, undo, linking]);

  if (projects.length === 0) {
    return <p className="text-sm text-text-secondary">No projects yet. Import a Gantt with cli_import.py.</p>;
  }

  const barSwatch = (project: GanttProject, task: GanttTask): Swatch => {
    if (!colorField) return projectSwatch(project);
    const value = task.custom_fields?.[colorField.id];
    const color = typeof value === "string" ? colorField.colors?.[value] : undefined;
    return color ? hexSwatch(color) : NEUTRAL;
  };

  // Timeline window: whole weeks around every dated task and today, with breathing room (more when bars can be
  // dragged, so there is somewhere to drag them to).
  const spans = allTasks.map(span).filter((s): s is Span => s !== null);
  const first = weekStart(Math.min(today, ...spans.map((s) => s.start))) - (editable ? 7 : 0);
  const last = weekStart(Math.max(today, ...spans.map((s) => s.end))) + (editable ? 35 : 14);
  const width = (last - first) * DAY_PX;
  const x = (day: number) => (day - first) * DAY_PX;
  const weeks = Array.from({ length: (last - first) / 7 }, (_, i) => first + i * 7);
  const weekends = Array.from({ length: last - first }, (_, i) => first + i).filter(isWeekend);

  /** The day under the pointer, or null over the task labels or outside the timeline. */
  const dayAt = (clientX: number): number | null => {
    const scroller = scrollerRef.current;
    if (!scroller) return null;
    const rect = scroller.getBoundingClientRect();
    const offset = clientX - rect.left;
    if (offset < labelW || offset > rect.width) return null;
    const day = first + Math.floor((offset - labelW + scroller.scrollLeft) / DAY_PX);
    return day >= first && day < last ? day : null;
  };

  const onGridMove = (e: ReactPointerEvent) => {
    if (linking) {
      const pointer = linkPoint(e.clientX, e.clientY);
      setLinking((current) => current && { ...current, pointer });
      return;
    }
    if (!editable || drag || resizing || e.pointerType === "touch") return;
    // Keep the cursor where it is while the pointer is on its own shift button.
    if ((e.target as HTMLElement).closest("[data-gantt-cursor]")) return;
    const overTask = (e.target as HTMLElement).closest("[data-gantt-bar], [data-gantt-control]");
    setHoverDay(overTask ? null : dayAt(e.clientX));
  };

  const onGridClick = (e: ReactMouseEvent) => {
    if (!editable || suppressClick.current) return;
    const target = e.target as HTMLElement;
    // While linking, a click on a task's row links it; anywhere else gives up.
    if (linking && !target.closest("[data-gantt-bar], [data-gantt-control], button, input, a, label")) {
      const row = target.closest<HTMLElement>("[data-task-row]");
      if (row) void link(linking.from, Number(row.dataset.taskRow));
      else setLinking(null);
      return;
    }
    if (target.closest("[data-gantt-bar], [data-gantt-control], button, input, a, label")) return;
    const day = dayAt(e.clientX);
    if (day === null) return;
    // Ctrl/⌘- or Shift-click on a task's row selects it, like clicking its bar.
    const row = target.closest<HTMLElement>("[data-task-row]");
    const mods = modifiers(e);
    if (row && (mods.toggle || mods.range)) {
      clickTask(Number(row.dataset.taskRow), mods);
      return;
    }
    if (selected.size > 0) setSelected(new Set());
  };

  // Each dated task's row middle (y), as the rows are laid out below: the header, then per project its milestones'
  // row and a row per bar (or one "No dated tasks" row), and a 1px border between projects.
  const rowMiddle = new Map<number, number>();
  let rowTop = HEADER_H;
  for (const project of projects) {
    const dated = project.tasks.filter((t) => span(t) !== null);
    dated.filter((t) => t.is_milestone).forEach((t) => rowMiddle.set(t.id, rowTop + ROW_H / 2));
    rowTop += ROW_H;
    for (const t of dated.filter((t) => !t.is_milestone)) {
      rowMiddle.set(t.id, rowTop + ROW_H / 2);
      rowTop += ROW_H;
    }
    if (dated.length === 0) rowTop += ROW_H;
    rowTop += 1;
  }

  /** A task with the drag in progress applied, so the arrows and their warnings follow the bars. */
  const live = (task: GanttTask): GanttTask => {
    const change = drag?.moved && drag.ids.includes(task.id) ? dragChange(task, drag.mode, drag.delta) : null;
    return change ? { ...task, ...change } : task;
  };
  /** Where an arrow leaves (`end`) or meets (`start`) a task's bar or milestone. */
  const linkEnd = (task: GanttTask, side: "start" | "end"): number => {
    const s = shown(task);
    if (task.is_milestone) return x(s.start) + DAY_PX / 2 + (side === "end" ? 7 : -7);
    return side === "end" ? x(s.end + 1) : x(s.start);
  };
  const linkShapes: LinkShape[] = links.flatMap((link) => {
    const [from, to] = [taskById.get(link.predecessor_id), taskById.get(link.successor_id)];
    if (!from || !to || !rowMiddle.has(from.id) || !rowMiddle.has(to.id)) return [];
    return [
      {
        link,
        from: live(from),
        to: live(to),
        x1: linkEnd(from, "end"),
        y1: rowMiddle.get(from.id)!,
        x2: linkEnd(to, "start") - 1,
        y2: rowMiddle.get(to.id)!,
        conflict: linkConflict(live(from), live(to), link.lag_days),
      },
    ];
  });
  const openShape = openLink ? linkShapes.find((shape) => shape.link.id === openLink.id) : undefined;
  const linkingFrom = linking ? taskById.get(linking.from) : undefined;
  const rubberBand =
    linking?.pointer && linkingFrom && rowMiddle.has(linkingFrom.id)
      ? { x1: linkEnd(linkingFrom, "end"), y1: rowMiddle.get(linkingFrom.id)!, x2: linking.pointer.x, y2: linking.pointer.y }
      : null;

  const datedOrder = order.length;
  const selectedCount = selected.size;
  const dragged = drag?.moved ? drag : null;

  return (
    <div className="space-y-4 select-none">
      {(dropdowns.length > 0 || editable) && (
        <div className="flex min-h-8 flex-wrap items-center justify-between gap-x-4 gap-y-2 text-xs text-text-muted">
          {dropdowns.length > 0 ? (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
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
          ) : (
            <span />
          )}
          {editable && (
            <div className="flex flex-wrap items-center gap-2" role="toolbar" aria-label="Gantt selection">
              {linkError && (
                <span role="alert" className="text-accent">
                  {linkError}
                </span>
              )}
              {linkingFrom ? (
                <>
                  <span role="status" className="rounded-full bg-accent/[0.16] px-2.5 py-0.5 font-semibold text-accent-soft">
                    Click the task that waits on “{linkingFrom.name}”
                  </span>
                  <button type="button" className="btn min-h-0 px-2.5 py-1 text-xs" onClick={() => setLinking(null)}>
                    Cancel
                  </button>
                </>
              ) : selectedCount > 0 ? (
                <>
                  <span className="rounded-full bg-accent/[0.16] px-2.5 py-0.5 font-semibold text-accent-soft">
                    {plural(selectedCount, "task")} selected
                  </span>
                  <span className="hidden text-text-muted lg:inline">Drag any of them to move them together</span>
                  <button type="button" className="btn min-h-0 px-2.5 py-1 text-xs" onClick={() => setSelected(new Set())}>
                    Clear
                  </button>
                </>
              ) : (
                <span className="hidden text-text-muted md:inline">
                  Drag bars to reschedule · <Kbd>Ctrl</Kbd>/<Kbd>Shift</Kbd>+click to select · use the cursor's shift button to shift the timeline
                  {linkable && " · drag a bar's end dot onto a task to link them"}
                </span>
              )}
            </div>
          )}
        </div>
      )}
      <div ref={chartRef} className="relative" style={{ "--gantt-label-w": `${labelW}px` } as CSSProperties}>
        <div ref={scrollerRef} className="overflow-x-auto rounded-lg border border-border-default bg-surface-raised">
          <div
            ref={contentRef}
            className={`relative ${linking ? "[&_[data-grid]]:cursor-alias [&_[data-gantt-bar]]:cursor-alias" : editable && !drag && !resizing ? "[&_[data-grid]]:cursor-crosshair" : ""}`}
            style={{ width: `calc(var(--gantt-label-w) + ${width}px)` }}
            onPointerMove={onGridMove}
            onPointerLeave={() => setHoverDay(null)}
            onClick={onGridClick}
          >
            {/* Weekends, week gridlines and the today marker, behind the rows. */}
            <div className="pointer-events-none absolute inset-y-0" style={{ left: "var(--gantt-label-w)", width }}>
              {weekends.map((day) => (
                <div key={day} className="absolute inset-y-0 bg-text-primary/[0.025]" style={{ left: x(day), width: DAY_PX }} />
              ))}
              {weeks.map((day) => (
                <div key={day} className="absolute inset-y-0 border-l border-border-default/60" style={{ left: x(day) }} />
              ))}
              <div className="absolute inset-y-0 border-l border-dashed border-accent" style={{ left: x(today) }} />
            </div>

            <div className="flex h-10 border-b border-border-default">
              <div
                className="sticky left-0 z-10 flex shrink-0 items-center gap-2 border-r border-border-default bg-surface-raised pl-3 text-xs text-text-muted"
                style={{ width: "var(--gantt-label-w)" }}
              >
                {editable && datedOrder > 0 && (
                  <TriCheckbox
                    label="Select all tasks"
                    checked={selectedCount === datedOrder}
                    indeterminate={selectedCount > 0 && selectedCount < datedOrder}
                    onChange={(on) => setSelected(on ? new Set(order) : new Set())}
                  />
                )}
                <span className="font-mono uppercase tracking-wide">Task</span>
              </div>
              <div data-grid className="relative font-mono text-xs text-text-muted" style={{ width }}>
                {weeks.map((day) => (
                  <span key={day} className="absolute bottom-1.5 pl-1.5" style={{ left: x(day) }}>
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
              const projectSelected = dated.filter((t) => selected.has(t.id)).length;
              return (
                <div key={project.id} className="border-b border-border-default last:border-b-0">
                  <Row
                    label={
                      <span className="flex min-w-0 items-center gap-2 pl-3">
                        {editable && dated.length > 0 && (
                          <TriCheckbox
                            label={`Select the tasks of ${project.code}`}
                            checked={projectSelected === dated.length}
                            indeterminate={projectSelected > 0 && projectSelected < dated.length}
                            onChange={(on) => setMany(dated.map((t) => t.id), on)}
                          />
                        )}
                        <ProjectLabel project={project} dot={swatch.dot} />
                      </span>
                    }
                    width={width}
                  >
                    {milestones.map((m) => (
                      <Milestone
                        key={m.id}
                        task={m}
                        day={shown(m).start}
                        x={x}
                        active={m.id === activeTaskId}
                        selected={selected.has(m.id)}
                        clickable={!!onTaskClick || editable}
                        dragging={!!dragged?.ids.includes(m.id)}
                        ghostDay={dragged?.ids.includes(m.id) ? span(m)!.start : null}
                        onPointerDown={editable && !linking ? (e) => beginDrag(e, m, "move") : undefined}
                        onClick={(e) => !suppressClick.current && clickTask(m.id, modifiers(e))}
                      />
                    ))}
                  </Row>
                  {bars.map((task) => (
                    <Row
                      key={task.id}
                      taskId={task.id}
                      label={
                        <TaskLabel
                          task={task}
                          editable={editable}
                          selected={selected.has(task.id)}
                          active={task.id === activeTaskId}
                          clickable={!!onTaskClick || editable}
                          onCheck={(e) => checkTask(task.id, e)}
                          onClick={(e) => clickTask(task.id, modifiers(e))}
                        />
                      }
                      width={width}
                      active={task.id === activeTaskId}
                      selected={selected.has(task.id)}
                      hoverable={editable}
                    >
                      <TaskBar
                        task={task}
                        span={shown(task)}
                        ghost={dragged?.ids.includes(task.id) ? span(task) : null}
                        x={x}
                        swatch={barSwatch(project, task)}
                        selected={selected.has(task.id)}
                        editable={editable}
                        drag={dragged?.ids.includes(task.id) ? dragged : null}
                        dragCount={dragged?.ids.length ?? 0}
                        onPointerDown={(e, mode) => !linking && beginDrag(e, task, mode)}
                        onLinkStart={linkable && !linking ? (e) => beginLink(e, task) : undefined}
                        onLinkKey={() => setLinking({ from: task.id, pointer: null })}
                        onClick={
                          onTaskClick || editable ? (e) => !suppressClick.current && clickTask(task.id, modifiers(e)) : undefined
                        }
                      />
                    </Row>
                  ))}
                  {dated.length === 0 && (
                    <Row label={<span className="pl-4 text-text-muted">No dated tasks</span>} width={width} />
                  )}
                </div>
              );
            })}

            {/* Dependency arrows, over the bars but under the sticky labels. */}
            {(linkShapes.length > 0 || rubberBand) && (
              <LinkLayer
                shapes={linkShapes}
                width={width}
                activeLinkId={openShape?.link.id ?? null}
                rubberBand={rubberBand}
                onOpen={(id, cx, cy) => !linking && setOpenLink({ id, x: cx, y: cy })}
              />
            )}

            {/* The grid cursor, over the bars but under the sticky labels. */}
            {editable && (
              <div className="pointer-events-none absolute inset-y-0 z-[5]" style={{ left: "var(--gantt-label-w)", width }}>
                {hoverDay !== null && (
                  <>
                    <div className="absolute inset-y-0 bg-text-primary/[0.04]" style={{ left: x(hoverDay), width: DAY_PX }} />
                    <div className="absolute inset-y-0 w-px bg-text-secondary/60" style={{ left: x(hoverDay) }} />
                    <div
                      data-gantt-control
                      data-gantt-cursor
                      className="pointer-events-auto absolute top-0.5 flex h-4 -translate-x-1/2 items-center overflow-hidden whitespace-nowrap rounded-full border border-border-default bg-surface-panel font-mono text-[11px] leading-none text-text-secondary shadow-sm"
                      style={{ left: x(hoverDay) }}
                    >
                      <span className="px-1.5">{formatDay(hoverDay, { weekday: true })}</span>
                      <button
                        type="button"
                        title={`Shift the timeline from ${formatDay(hoverDay, { weekday: true })}…`}
                        aria-label={`Shift the timeline from ${formatDay(hoverDay)}`}
                        onClick={() => setShiftAnchor(hoverDay)}
                        className="flex h-full items-center border-l border-border-default px-1.5 text-text-muted transition-colors hover:bg-accent hover:text-text-onAccent"
                      >
                        <ShiftIcon />
                      </button>
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        </div>
        <LabelResizer width={labelW} resizing={resizing} onPointerDown={beginResize} onKeyDown={resizeByKey} onReset={() => setLabelW(clampLabelW(LABEL_DEFAULT_W))} />
      </div>

      {projects.map((project) => (
        <Unscheduled key={project.id} project={project} onTaskClick={onTaskClick} activeTaskId={activeTaskId} />
      ))}

      {shiftAnchor !== null && (
        <GanttShiftDialog
          reference={shiftAnchor}
          tasks={allTasks}
          selectedIds={selected}
          onApply={(shifted: ShiftedTask[], delta: number) => save(shifted.map((s) => s.change), `Shifted ${plural(shifted.length, "task")} · ${formatDelta(delta)}`)}
          onClose={() => setShiftAnchor(null)}
        />
      )}

      {toast && <UndoToast toast={toast} onUndo={undo} onClose={() => setToast(null)} />}

      {openShape && openLink && (
        <LinkPopover
          key={openShape.link.id}
          shape={openShape}
          at={openLink}
          onDelete={
            linkable
              ? async () => {
                  await deleteTaskLink(openShape.link.id);
                  setOpenLink(null);
                }
              : undefined
          }
          onClose={() => setOpenLink(null)}
        />
      )}
    </div>
  );
}

function Row({
  label,
  width,
  active,
  selected,
  hoverable,
  taskId,
  children,
}: {
  label: ReactNode;
  width: number;
  active?: boolean;
  selected?: boolean;
  hoverable?: boolean;
  taskId?: number;
  children?: ReactNode;
}) {
  // The sticky label stays opaque (bars scroll under it); the selection and hover tints are layered on top.
  const tint = selected ? "bg-accent/[0.09]" : hoverable ? "group-hover/row:bg-text-primary/[0.035]" : "";
  return (
    <div className={`group/row flex h-9 items-stretch ${active ? "bg-surface-active" : ""}`} data-task-row={taskId}>
      <div
        className={`sticky left-0 z-10 flex shrink-0 items-center border-r border-border-default pr-3 text-sm ${
          active ? "bg-surface-active" : "bg-surface-raised"
        }`}
        style={{ width: "var(--gantt-label-w)" }}
      >
        <span className={`pointer-events-none absolute inset-0 transition-colors ${tint}`} />
        {selected && <span className="pointer-events-none absolute inset-y-0 left-0 w-0.5 bg-accent" />}
        <span className="relative flex min-w-0 flex-1 items-center">{label}</span>
      </div>
      <div data-grid className={`relative transition-colors ${tint}`} style={{ width }}>
        {children}
      </div>
    </div>
  );
}

/**
 * The grip on the labels column's right edge, over the chart's full height. It sits outside the horizontally scrolling
 * part, so it stays on the column's edge (which is sticky) however far the timeline is scrolled.
 */
function LabelResizer({
  width,
  resizing,
  onPointerDown,
  onKeyDown,
  onReset,
}: {
  width: number;
  resizing: boolean;
  onPointerDown: (e: ReactPointerEvent) => void;
  onKeyDown: (e: ReactKeyboardEvent) => void;
  onReset: () => void;
}) {
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the task column"
      aria-valuenow={width}
      aria-valuemin={LABEL_MIN_W}
      aria-valuemax={LABEL_MAX_W}
      tabIndex={0}
      title="Drag to resize the task column (double-click to reset)"
      // Centred on the column's border: 1px of the chart's border, then the column, whose last pixel is its border.
      className="group/resizer absolute inset-y-0 z-20 flex w-[9px] cursor-col-resize touch-none justify-center outline-none"
      style={{ left: "calc(var(--gantt-label-w) - 4px)" }}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      onDoubleClick={onReset}
    >
      <span
        className={`h-full w-[2px] transition-colors ${
          resizing ? "bg-accent" : "bg-transparent group-hover/resizer:bg-accent/60 group-focus-visible/resizer:bg-accent"
        }`}
      />
    </div>
  );
}

/** A checkbox that can show "some" (indeterminate), for selecting a group of tasks. */
function TriCheckbox({ label, checked, indeterminate, onChange }: { label: string; checked: boolean; indeterminate: boolean; onChange: (on: boolean) => void }) {
  return (
    <input
      type="checkbox"
      aria-label={label}
      title={label}
      checked={checked}
      ref={(el) => {
        if (el) el.indeterminate = indeterminate;
      }}
      onChange={(e) => onChange(e.target.checked)}
      className="shrink-0 cursor-pointer accent-[var(--dc-accent)]"
    />
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
    <span className="flex min-w-0 items-center gap-2 font-semibold" title={project.name}>
      <span className={`h-2 w-2 shrink-0 rounded-full ${dot.className}`} style={dot.style} />
      <span>{project.code}</span>
      {project.name !== project.code && <span className="truncate font-normal text-text-muted">{project.name}</span>}
    </span>
  );
}

function TaskLabel({
  task,
  editable,
  selected,
  active,
  clickable,
  onCheck,
  onClick,
}: {
  task: GanttTask;
  editable: boolean;
  selected: boolean;
  active: boolean;
  clickable: boolean;
  onCheck: (e: ReactMouseEvent) => void;
  onClick: (e: ReactMouseEvent) => void;
}) {
  return (
    <span className="flex min-w-0 items-center gap-2 pl-4">
      {editable && (
        <input
          type="checkbox"
          aria-label={`Select ${task.name}`}
          checked={selected}
          readOnly
          onClick={onCheck}
          className="shrink-0 cursor-pointer accent-[var(--dc-accent)]"
        />
      )}
      {clickable ? (
        <button
          type="button"
          onClick={onClick}
          // Shift-click selects a range: don't let it select the label text as well.
          onMouseDown={(e) => e.shiftKey && e.preventDefault()}
          title={editable ? "Open task details (Ctrl/⌘-click or Shift-click to select)" : "Open task details"}
          aria-current={active || undefined}
          className={`truncate text-left hover:underline ${active || selected ? "text-text-primary" : "text-text-secondary"}`}
        >
          {task.name}
        </button>
      ) : (
        <span className="truncate text-text-secondary">{task.name}</span>
      )}
    </span>
  );
}

function Milestone({
  task,
  day,
  x,
  active,
  selected,
  clickable,
  dragging,
  ghostDay,
  onPointerDown,
  onClick,
}: {
  task: GanttTask;
  day: number;
  x: (day: number) => number;
  active: boolean;
  selected: boolean;
  clickable: boolean;
  dragging: boolean;
  ghostDay: number | null;
  onPointerDown?: (e: ReactPointerEvent) => void;
  onClick: (e: ReactMouseEvent) => void;
}) {
  const left = (d: number) => x(d) + DAY_PX / 2 - 6;
  return (
    <>
      {ghostDay !== null && ghostDay !== day && (
        <span
          className="pointer-events-none absolute top-1/2 h-3 w-3 -translate-y-1/2 rotate-45 border border-dashed border-accent/70"
          style={{ left: left(ghostDay) }}
        />
      )}
      <div
        data-gantt-bar
        data-gantt-task={task.id}
        className={`absolute top-1/2 flex -translate-y-1/2 select-none items-center gap-1.5 whitespace-nowrap ${
          onPointerDown ? (dragging ? "z-20 cursor-grabbing" : "cursor-grab") : clickable ? "cursor-pointer" : ""
        } ${clickable && !dragging ? "hover:underline" : ""} ${active ? "underline" : ""}`}
        style={{ left: left(day) }}
        title={dragging ? undefined : `${task.name} · ${formatDay(day)}`}
        onPointerDown={onPointerDown}
        onClick={onClick}
      >
        <span
          className={`h-3 w-3 rotate-45 bg-accent transition-shadow ${
            selected ? "ring-2 ring-accent ring-offset-2 ring-offset-surface-raised" : ""
          } ${dragging ? "shadow-lg" : ""}`}
        />
        <span className="font-mono text-xs text-accent">
          {task.name} · {formatDay(day)}
        </span>
      </div>
    </>
  );
}

function TaskBar({
  task,
  span,
  ghost,
  x,
  swatch,
  selected,
  editable,
  drag,
  dragCount,
  onPointerDown,
  onLinkStart,
  onLinkKey,
  onClick,
}: {
  task: GanttTask;
  span: Span;
  /** Where the bar was before the drag in progress. */
  ghost: Span | null;
  x: (day: number) => number;
  swatch: Swatch;
  selected: boolean;
  editable: boolean;
  /** The drag moving this bar, if any. */
  drag: Drag | null;
  dragCount: number;
  onPointerDown: (e: ReactPointerEvent, mode: DragMode) => void;
  /** Pressing the connector on the bar's right end, to link the task to one that waits on it. */
  onLinkStart?: (e: ReactPointerEvent) => void;
  /** Enter or Space on the connector: pick the waiting task with a click. */
  onLinkKey?: () => void;
  onClick?: (e: ReactMouseEvent) => void;
}) {
  const percent = Math.round(task.completion_percent);
  const left = x(span.start);
  const days = span.end - span.start + 1;
  const width = days * DAY_PX;
  const resizable = editable && width >= HANDLE_PX * 3;
  const isOrigin = drag?.originId === task.id;
  return (
    <>
      {ghost && (
        <div
          className="pointer-events-none absolute top-1/2 h-5 -translate-y-1/2 rounded-md border border-dashed border-text-muted/60"
          style={{ left: x(ghost.start), width: (ghost.end - ghost.start + 1) * DAY_PX }}
        />
      )}
      <div
        data-gantt-bar
        data-gantt-task={task.id}
        className={`group/bar absolute top-1/2 flex -translate-y-1/2 select-none items-center gap-2 whitespace-nowrap ${
          drag ? "z-20" : ""
        } ${onClick && !editable ? "cursor-pointer" : ""}`}
        style={{ left }}
        title={drag ? undefined : `${task.name} · ${formatDay(span.start)} – ${formatDay(span.end)} · ${percent}%`}
        onClick={onClick}
      >
        {/* The completed part is left hollow (the track shows through); the work still to do is filled. */}
        <div
          className={`relative flex h-5 overflow-hidden rounded-md border transition-shadow ${swatch.track.className} ${
            editable ? (drag ? "cursor-grabbing" : "cursor-grab") : ""
          } ${selected ? "ring-2 ring-accent ring-offset-1 ring-offset-surface-raised" : ""} ${drag ? "shadow-lg" : editable ? "hover:shadow-md" : ""}`}
          style={{ ...swatch.track.style, width }}
          onPointerDown={editable ? (e) => onPointerDown(e, "move") : undefined}
        >
          <div className="h-full shrink-0" style={{ width: `${percent}%` }} />
          <div className={`h-full flex-1 ${swatch.fill.className}`} style={swatch.fill.style} />
          {resizable && (
            <>
              <ResizeHandle side="start" active={drag?.mode === "start"} onPointerDown={(e) => onPointerDown(e, "start")} />
              <ResizeHandle side="end" active={drag?.mode === "end"} onPointerDown={(e) => onPointerDown(e, "end")} />
            </>
          )}
        </div>
        {onLinkStart && !drag && (
          <span
            data-gantt-control
            role="button"
            tabIndex={0}
            aria-label={`Link ${task.name} to a task that waits on it`}
            title="Drag onto a task (or click, then click the task) to make it wait on this one"
            className="absolute top-1/2 z-[7] h-3 w-3 -translate-x-1/2 -translate-y-1/2 cursor-crosshair rounded-full border-2 border-accent bg-surface-raised opacity-0 transition-opacity hover:bg-accent focus-visible:opacity-100 group-hover/bar:opacity-100"
            style={{ left: width + LINK_HANDLE_OFFSET }}
            onPointerDown={onLinkStart}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key !== "Enter" && e.key !== " ") return;
              e.preventDefault();
              e.stopPropagation();
              onLinkKey?.();
            }}
          />
        )}
        <span className={`font-mono text-xs text-text-muted ${onLinkStart ? "pl-3" : ""}`}>{percent}%</span>
        {/* While dragging, the new dates float above the bar's start, where the timeline is sure to show them. */}
        {drag && isOrigin && (
          <span
            role="status"
            className="pointer-events-none absolute bottom-full left-0 mb-1.5 rounded-md bg-text-primary px-1.5 py-0.5 font-mono text-[11px] text-surface-raised shadow-md"
          >
            {dragCount > 1 && `${dragCount} tasks · `}
            {drag.mode === "end" ? `due ${formatDay(span.end)}` : drag.mode === "start" ? `starts ${formatDay(span.start)}` : `${formatDay(span.start)} – ${formatDay(span.end)}`}
            {drag.mode !== "move" && ` · ${days}d`}
            <span className={drag.delta === 0 ? "opacity-60" : "text-accent"}> · {formatDelta(drag.delta)}</span>
          </span>
        )}
      </div>
    </>
  );
}

/** A grip on a bar's edge: drag it to change the task's start (left) or due date (right). */
function ResizeHandle({ side, active, onPointerDown }: { side: "start" | "end"; active: boolean; onPointerDown: (e: ReactPointerEvent) => void }) {
  return (
    <div
      aria-hidden
      className={`absolute inset-y-0 flex cursor-ew-resize items-center justify-center ${side === "start" ? "left-0" : "right-0"}`}
      style={{ width: HANDLE_PX }}
      onPointerDown={onPointerDown}
      title={side === "start" ? "Drag to change the start date" : "Drag to change the due date"}
    >
      <span
        className={`h-2.5 w-[2px] rounded-full bg-white/90 shadow-[0_0_0_1px_rgba(0,0,0,0.25)] transition-opacity ${
          active ? "opacity-100" : "opacity-0 group-hover/bar:opacity-100"
        }`}
      />
    </div>
  );
}

/** A dependency as drawn on the chart: from the predecessor's right end to the successor's left end. */
type LinkShape = { link: LinkWithDetails; from: GanttTask; to: GanttTask; x1: number; y1: number; x2: number; y2: number; conflict: string | null };

/** Room an arrow leaves past the predecessor before turning. */
const LINK_STUB_OUT = 12;
/** Room an arrow takes before the successor, so a doubled-back arrow still gets a clean horizontal approach. */
const LINK_STUB_IN = 24;
/** How far the drag-to-link handle sits off a bar's right end. */
const LINK_HANDLE_OFFSET = 8;
const CONFLICT_COLOR = "#f59e0b";

/**
 * Why `from`'s and `to`'s dates contradict a finish-to-start link (`to` starts, or without a start is due, on or
 * before the day `from` finishes plus the lag — 0-day tolerance, as `from` occupies its finish day), or null. The same rule as `_link_conflict` in backend/main.py, worked out here so the
 * warning follows bars as they're dragged.
 */
function linkConflict(from: GanttTask, to: GanttTask, lagDays: number): string | null {
  if (!from.end_date) return null;
  const finish = toDay(from.end_date);
  const earliest = finish + Math.round(lagDays);
  const finishes = `${from.name} finishes on ${formatDay(finish)}`;
  if (to.start_date) {
    const start = toDay(to.start_date);
    if (start < earliest) return `${finishes}, after ${to.name} starts on ${formatDay(start)}`;
    if (start === earliest) return `${finishes}, the same day ${to.name} starts on ${formatDay(start)}`;
    return null;
  }
  if (to.end_date) {
    const due = toDay(to.end_date);
    if (due < earliest) return `${finishes}, after ${to.name} is due on ${formatDay(due)}`;
    if (due === earliest) return `${finishes}, the same day ${to.name} is due on ${formatDay(due)}`;
  }
  return null;
}

/** An elbowed path from (x1, y1) to (x2, y2): out, down, in; doubling back along a row boundary when `to` starts first. */
function linkPath({ x1, y1, x2, y2 }: Pick<LinkShape, "x1" | "y1" | "x2" | "y2">): { d: string; mid: { x: number; y: number } } {
  if (x2 - x1 >= LINK_STUB_OUT + LINK_STUB_IN) {
    const turn = x1 + LINK_STUB_OUT;
    return { d: `M${x1},${y1} H${turn} V${y2} H${x2}`, mid: { x: turn, y: (y1 + y2) / 2 } };
  }
  const boundary = y1 + (y2 >= y1 ? 1 : -1) * (ROW_H / 2);
  const out = x1 + LINK_STUB_OUT;
  const back = Math.max(4, x2 - LINK_STUB_IN);
  return { d: `M${x1},${y1} H${out} V${boundary} H${back} V${y2} H${x2}`, mid: { x: (out + back) / 2, y: boundary } };
}

/**
 * The dependency arrows over the bars (under the sticky labels). Arrows ignore the pointer except along their own
 * stroke, so bars underneath can still be dragged; clicking one (or its caution triangle) opens it.
 */
function LinkLayer({
  shapes,
  width,
  activeLinkId,
  rubberBand,
  onOpen,
}: {
  shapes: LinkShape[];
  width: number;
  activeLinkId: number | null;
  rubberBand: { x1: number; y1: number; x2: number; y2: number } | null;
  onOpen: (linkId: number, clientX: number, clientY: number) => void;
}) {
  const ids = useId().replace(/:/g, "");
  const arrow = `gantt-arrow-${ids}`;
  const warnArrow = `gantt-arrow-warn-${ids}`;
  const activeArrow = `gantt-arrow-active-${ids}`;
  const marker = (id: string, className: string, fill?: string) => (
    <marker id={id} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse" className={className}>
      <path d="M0,0.5 L7.5,4 L0,7.5 z" fill={fill ?? "currentColor"} />
    </marker>
  );
  return (
    <svg
      aria-hidden={shapes.length === 0 && !rubberBand}
      className="pointer-events-none absolute z-[6] overflow-visible text-text-muted"
      style={{ left: "var(--gantt-label-w)", top: 0, width, height: "100%" }}
    >
      <defs>
        {marker(arrow, "text-text-muted")}
        {marker(warnArrow, "", CONFLICT_COLOR)}
        {marker(activeArrow, "text-accent")}
      </defs>
      {shapes.map((shape) => {
        const { d, mid } = linkPath(shape);
        const active = shape.link.id === activeLinkId;
        const color = active ? "var(--dc-accent)" : shape.conflict ? CONFLICT_COLOR : "currentColor";
        const open = (e: ReactMouseEvent) => {
          e.stopPropagation();
          onOpen(shape.link.id, e.clientX, e.clientY);
        };
        const label = `${shape.from.name} → ${shape.to.name}${shape.conflict ? ` · ⚠ ${shape.conflict}` : ""}`;
        return (
          <g key={shape.link.id} data-gantt-control className="group/link cursor-pointer" onClick={open}>
            <title>{label}</title>
            {/* A wide, invisible stroke makes the thin arrow easy to hover and click. */}
            <path d={d} fill="none" stroke="transparent" strokeWidth={10} style={{ pointerEvents: "stroke" }} />
            <path
              d={d}
              fill="none"
              stroke={color}
              strokeWidth={active ? 2 : 1.5}
              strokeLinejoin="round"
              strokeDasharray={shape.conflict && !active ? "4 3" : undefined}
              markerEnd={`url(#${active ? activeArrow : shape.conflict ? warnArrow : arrow})`}
              className="opacity-70 transition-opacity group-hover/link:opacity-100"
            />
            {shape.conflict && (
              <g transform={`translate(${mid.x}, ${mid.y})`} style={{ pointerEvents: "all" }}>
                <path d="M0,-7 L7,5.5 L-7,5.5 Z" fill={CONFLICT_COLOR} stroke="var(--dc-surface, #fff)" strokeWidth={1} strokeLinejoin="round" />
                <path d="M0,-2.5 V1.5 M0,3.4 V3.6" stroke="#1f1300" strokeWidth={1.4} strokeLinecap="round" />
              </g>
            )}
          </g>
        );
      })}
      {rubberBand && (
        <path
          d={`M${rubberBand.x1},${rubberBand.y1} L${rubberBand.x2},${rubberBand.y2}`}
          fill="none"
          stroke="var(--dc-accent)"
          strokeWidth={1.5}
          strokeDasharray="4 3"
          markerEnd={`url(#${activeArrow})`}
        />
      )}
    </svg>
  );
}

/** A dependency's details, opened by clicking its arrow: the two tasks and their dates, any conflict, and Delete. */
function LinkPopover({
  shape,
  at,
  onDelete,
  onClose,
}: {
  shape: LinkShape;
  at: { x: number; y: number };
  onDelete?: () => Promise<void>;
  onClose: () => void;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (!panel.current?.contains(e.target as Node)) close.current();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      close.current();
    };
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
    };
  }, []);

  const dates = (task: GanttTask) => {
    const s = span(task);
    if (!s) return "no dates";
    return s.start === s.end ? formatDay(s.start) : `${formatDay(s.start)} – ${formatDay(s.end)}`;
  };
  const left = Math.min(at.x, window.innerWidth - 300);
  const top = Math.min(at.y + 10, window.innerHeight - 180);

  return createPortal(
    <div
      ref={panel}
      role="dialog"
      aria-label="Dependency"
      className="fixed z-50 flex w-[280px] flex-col gap-2 rounded-lg border border-border-default bg-surface-raised p-3 text-[13px] shadow-xl"
      style={{ left, top }}
    >
      <div className="flex flex-col gap-1">
        <span className="font-mono text-[11px] uppercase tracking-wide text-text-muted">Dependency</span>
        <span className="flex min-w-0 items-baseline gap-1.5 text-text-primary">
          <span className="truncate font-semibold" title={shape.from.name}>
            {shape.from.name}
          </span>
          <span className="shrink-0 text-text-muted">→</span>
          <span className="truncate font-semibold" title={shape.to.name}>
            {shape.to.name}
          </span>
        </span>
        <span className="text-xs text-text-muted">
          {dates(shape.from)} → {dates(shape.to)}
        </span>
      </div>
      {shape.conflict ? (
        <p className="flex gap-1.5 rounded-md border px-2 py-1.5 text-xs" style={{ borderColor: `${CONFLICT_COLOR}99`, color: CONFLICT_COLOR }}>
          <span aria-hidden>⚠</span>
          <span>{shape.conflict}</span>
        </p>
      ) : (
        <p className="text-xs text-text-muted">The dates fit: {shape.to.name} waits until {shape.from.name} is done.</p>
      )}
      {error && <p className="text-xs text-accent">{error}</p>}
      <div className="flex justify-end gap-2">
        <button type="button" className="btn min-h-0 px-2.5 py-1 text-xs" onClick={onClose}>
          Close
        </button>
        {onDelete && (
          <button
            type="button"
            disabled={deleting}
            className="btn min-h-0 px-2.5 py-1 text-xs hover:text-accent"
            onClick={async () => {
              setDeleting(true);
              setError(null);
              try {
                await onDelete();
              } catch (err: unknown) {
                setError(`Could not delete the link: ${message(err)}`);
                setDeleting(false);
              }
            }}
          >
            {deleting ? "Deleting…" : "Delete link"}
          </button>
        )}
      </div>
    </div>,
    document.body,
  );
}

/** The latest change, saving or saved, with Undo. */
function UndoToast({ toast, onUndo, onClose }: { toast: Toast; onUndo: () => void; onClose: () => void }) {
  return createPortal(
    <div
      role="status"
      aria-live="polite"
      className="fixed bottom-6 left-1/2 z-40 flex -translate-x-1/2 animate-toast-in items-center gap-3 rounded-xl border border-border-default bg-surface-raised py-2 pl-4 pr-2 text-[13px] shadow-xl"
    >
      {toast.saving ? (
        <span className="h-3 w-3 animate-spin rounded-full border-[1.5px] border-text-muted border-t-transparent" aria-hidden />
      ) : (
        <svg aria-hidden width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className="text-accent">
          <path d="M2.5 7.5l3 3 6-7" />
        </svg>
      )}
      <span className="max-w-[420px] truncate text-text-primary">{toast.saving ? `${toast.label} · saving…` : toast.label}</span>
      {toast.inverse && (
        <button
          type="button"
          onClick={onUndo}
          disabled={toast.saving}
          title="Undo (Ctrl/⌘+Z)"
          className="rounded-md px-2 py-1 font-semibold text-accent-soft transition-colors hover:bg-accent/[0.12] disabled:opacity-40"
        >
          Undo
        </button>
      )}
      <button type="button" aria-label="Dismiss" onClick={onClose} className="rounded-md p-1.5 text-text-muted transition-colors hover:bg-surface-hover hover:text-text-primary">
        <svg aria-hidden width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
          <path d="M2 2l6 6M8 2l-6 6" />
        </svg>
      </button>
    </div>,
    document.body,
  );
}

function ShiftIcon() {
  return (
    <svg aria-hidden width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M1.5 6h9M8 3.5L10.5 6 8 8.5M1.5 2v8" />
    </svg>
  );
}

function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="rounded border border-border-default bg-surface-panel px-1 font-mono text-[11px] text-text-secondary">{children}</kbd>;
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
