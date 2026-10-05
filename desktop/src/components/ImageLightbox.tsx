import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { message } from "../lib/api";

/** The view: the image's scale (1 is its natural size) and its center's offset from the stage's, in screen pixels. */
type View = { zoom: number; x: number; y: number };
type Point = { x: number; y: number };
/** A markup stroke, in image pixels; each point carries its line width, which follows the pen's pressure. */
type Stroke = { color: string; points: (Point & { width: number })[] };
type Tool = "draw" | "pan";

const MIN_ZOOM = 0.05;
const MAX_ZOOM = 8;
const ZOOM_STEP = 1.25;
const clampZoom = (zoom: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));

/** Ink that reads on most images. */
const INKS = [
  { name: "Red", value: "#ef4444" },
  { name: "Yellow", value: "#facc15" },
  { name: "Green", value: "#22c55e" },
  { name: "Blue", value: "#3b82f6" },
  { name: "Black", value: "#111111" },
  { name: "White", value: "#ffffff" },
];
/** Line widths, in screen pixels at the zoom a stroke is drawn at. */
const SIZES = [2, 4, 8];
/** The markup canvas's limits, in device pixels: a larger one fails to allocate (and draws nothing) or eats memory. */
const MAX_CANVAS_SIDE = 16384;
const MAX_CANVAS_AREA = 4096 * 4096;

/**
 * A note's image, fullscreen: dragged to pan and zoomed with the wheel, a pinch or the footer's controls. Given
 * `onSave`, it can be marked up: a canvas over the image takes a stylus's (or, with the pen tool, the mouse's)
 * strokes, while touch still pans and pinch-zooms. Saving hands `onSave` the image with the strokes drawn on it, as
 * a PNG; closing or leaving markup saves them too, and Cancel discards them.
 */
export default function ImageLightbox({
  src,
  alt,
  title,
  onClose,
  onSave,
}: {
  src: string;
  alt?: string | null;
  title?: string | null;
  onClose: () => void;
  onSave?: (image: Blob) => Promise<void>;
}) {
  const stageRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const [view, setView] = useState<View>({ zoom: 1, x: 0, y: 0 });
  const viewRef = useRef(view);
  viewRef.current = view;
  const [markup, setMarkup] = useState(false);
  const [tool, setTool] = useState<Tool>("draw");
  const [ink, setInk] = useState(INKS[0].value);
  const [lineSize, setLineSize] = useState(SIZES[1]);
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The pointers down on the stage, where they last were: one pans, two pinch.
  const pointers = useRef(new Map<number, Point>());
  // The stroke being drawn, and the pointer drawing it.
  const drawing = useRef<{ pointerId: number; stroke: Stroke } | null>(null);

  // The markup canvas's device pixels per image pixel: enough for the screen at the current zoom, so strokes stay
  // sharp when zoomed in, within the canvas's limits.
  const renderScale = size
    ? Math.min(
        window.devicePixelRatio * Math.max(1, view.zoom),
        MAX_CANVAS_SIDE / Math.max(size.width, size.height),
        Math.sqrt(MAX_CANVAS_AREA / (size.width * size.height)),
      )
    : 1;
  const canvasWidth = size ? Math.max(1, Math.round(size.width * renderScale)) : 0;
  const canvasHeight = size ? Math.max(1, Math.round(size.height * renderScale)) : 0;

  const name = decodeURIComponent(new URL(src, window.location.href).pathname.split("/").pop() ?? "");

  /** The zoom that fits the image on the stage, at most its natural size. */
  function fitZoom(width: number, height: number): number {
    const stage = stageRef.current?.getBoundingClientRect();
    if (!stage) return 1;
    return clampZoom(Math.min(1, (stage.width - 48) / width, (stage.height - 48) / height));
  }

  function fit() {
    if (size) setView({ zoom: fitZoom(size.width, size.height), x: 0, y: 0 });
  }

  /** Zoom to `zoom`, keeping the image's point under `at` (client coordinates; the stage's center by default) there. */
  function zoomTo(zoom: number, at?: Point) {
    const stage = stageRef.current?.getBoundingClientRect();
    if (!stage) return;
    setView((v) => {
      const z = clampZoom(zoom);
      const px = at ? at.x - stage.left - stage.width / 2 : 0;
      const py = at ? at.y - stage.top - stage.height / 2 : 0;
      return { zoom: z, x: px - ((px - v.x) * z) / v.zoom, y: py - ((py - v.y) * z) / v.zoom };
    });
  }

  /** Save the strokes onto the image (if there are any), handing it to `onSave`; whether it went (or there were none). */
  async function save(): Promise<boolean> {
    const image = imageRef.current;
    const canvas = canvasRef.current;
    if (!strokes.length || !onSave || !image || !canvas || !size) return true;
    setSaving(true);
    setError(null);
    try {
      const merged = document.createElement("canvas");
      merged.width = size.width;
      merged.height = size.height;
      const context = merged.getContext("2d");
      if (!context) throw new Error("no canvas");
      context.drawImage(image, 0, 0, size.width, size.height);
      // The canvas is at the screen's resolution: scaled down onto the image's.
      context.drawImage(canvas, 0, 0, size.width, size.height);
      // An image from another site taints the canvas, which then can't be read back.
      const blob = await new Promise<Blob>((resolve, reject) =>
        merged.toBlob((b) => (b ? resolve(b) : reject(new Error("the image could not be encoded"))), "image/png"),
      );
      await onSave(blob);
      setStrokes([]);
      return true;
    } catch (err) {
      setError(`Could not save the markup (${err instanceof DOMException && err.name === "SecurityError" ? "the image is from another site" : message(err)}).`);
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function finishMarkup() {
    if (await save()) setMarkup(false);
  }

  async function close() {
    if (await save()) onClose();
  }

  function cancelMarkup() {
    setStrokes([]);
    setError(null);
    setMarkup(false);
  }

  // The latest `close`, for the key handler.
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    const keydown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        void closeRef.current();
      }
    };
    window.addEventListener("keydown", keydown, true);
    return () => window.removeEventListener("keydown", keydown, true);
  }, []);

  // React's wheel listener is passive, so it can't keep the page from scrolling: the stage's own is added here.
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      zoomTo(viewRef.current.zoom * Math.exp(-e.deltaY / 400), { x: e.clientX, y: e.clientY });
    };
    stage.addEventListener("wheel", wheel, { passive: false });
    return () => stage.removeEventListener("wheel", wheel);
  }, []);

  // The canvas shows the strokes: redrawn whole when they change (an undo, a clear, a save) or it's resized (a zoom,
  // which clears it), and added to as one's drawn. Before paint, so a zoom doesn't flash it blank.
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context || !size) return;
    context.resetTransform();
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.scale(canvas.width / size.width, canvas.height / size.height);
    // The stroke being drawn too: a pinch can zoom mid-stroke.
    for (const stroke of drawing.current ? [...strokes, drawing.current.stroke] : strokes) {
      for (let i = 1; i < stroke.points.length; i++) drawSegment(context, stroke, i);
      if (stroke.points.length === 1) drawDot(context, stroke);
    }
  }, [strokes, size, markup, canvasWidth, canvasHeight]);

  /** Draw on the canvas straight away, in image pixels. */
  function drawOnCanvas(draw: (context: CanvasRenderingContext2D) => void) {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context || !size) return;
    context.save();
    context.resetTransform();
    context.scale(canvas.width / size.width, canvas.height / size.height);
    draw(context);
    context.restore();
  }

  /** Whether a pointer draws: in markup, a pen or the mouse with the pen tool. Touch always pans. */
  const draws = (e: ReactPointerEvent) => markup && tool === "draw" && (e.pointerType === "pen" || e.pointerType === "mouse");

  /** A pointer's position on the image, in its pixels. */
  function imagePoint(e: { clientX: number; clientY: number }): Point | null {
    const canvas = canvasRef.current;
    if (!canvas || !size) return null;
    const rect = canvas.getBoundingClientRect();
    return { x: ((e.clientX - rect.left) / rect.width) * size.width, y: ((e.clientY - rect.top) / rect.height) * size.height };
  }

  /** A stroke's width in image pixels: the line size on screen at the current zoom, thickened by a pen's pressure. */
  const lineWidth = (pointerType: string, pressure: number) =>
    (lineSize / view.zoom) * (pointerType === "pen" ? 0.5 + (pressure || 0.5) : 1);

  function pointerDown(e: ReactPointerEvent) {
    if (e.button !== 0 && e.pointerType === "mouse") return;
    if (saving) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    if (draws(e)) {
      const point = imagePoint(e);
      if (!point || drawing.current) return;
      const width = lineWidth(e.pointerType, e.pressure);
      const stroke: Stroke = { color: ink, points: [{ ...point, width }] };
      drawing.current = { pointerId: e.pointerId, stroke };
      drawOnCanvas((context) => drawDot(context, stroke));
      return;
    }
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
  }

  function pointerMove(e: ReactPointerEvent) {
    const current = drawing.current;
    if (current?.pointerId === e.pointerId) {
      // A pen reports more points than it fires events for; they're all drawn, for a smooth line.
      const events = e.nativeEvent.getCoalescedEvents?.() ?? [];
      for (const event of events.length ? events : [e.nativeEvent]) {
        const point = imagePoint(event);
        if (!point) continue;
        current.stroke.points.push({ ...point, width: lineWidth(e.pointerType, event.pressure) });
        drawOnCanvas((context) => drawSegment(context, current.stroke, current.stroke.points.length - 1));
      }
      return;
    }
    const last = pointers.current.get(e.pointerId);
    if (!last) return;
    const others = [...pointers.current].filter(([id]) => id !== e.pointerId).map(([, p]) => p);
    const next = { x: e.clientX, y: e.clientY };
    pointers.current.set(e.pointerId, next);
    if (others.length === 0) {
      setView((v) => ({ ...v, x: v.x + next.x - last.x, y: v.y + next.y - last.y }));
      return;
    }
    // A pinch: zoom by how much the fingers spread, about their midpoint, and pan with it.
    const other = others[0];
    const before = { mid: midpoint(last, other), distance: distance(last, other) };
    const after = { mid: midpoint(next, other), distance: distance(next, other) };
    const stage = stageRef.current?.getBoundingClientRect();
    if (!stage || !before.distance) return;
    const center = { x: stage.left + stage.width / 2, y: stage.top + stage.height / 2 };
    setView((v) => {
      const zoom = clampZoom((v.zoom * after.distance) / before.distance);
      const from = { x: before.mid.x - center.x, y: before.mid.y - center.y };
      const to = { x: after.mid.x - center.x, y: after.mid.y - center.y };
      return { zoom, x: to.x - ((from.x - v.x) * zoom) / v.zoom, y: to.y - ((from.y - v.y) * zoom) / v.zoom };
    });
  }

  function pointerUp(e: ReactPointerEvent) {
    pointers.current.delete(e.pointerId);
    const current = drawing.current;
    if (current?.pointerId !== e.pointerId) return;
    drawing.current = null;
    setStrokes((s) => [...s, current.stroke]);
  }

  const editing = markup && !!onSave;
  const heading = title || alt || name;

  return createPortal(
    <div role="dialog" aria-modal aria-label={heading || "Image"} className="fixed inset-0 z-50 flex flex-col bg-background/95">
      <header className="flex min-h-14 items-center justify-between gap-4 border-b border-border-default px-5 py-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-text-primary">{heading || "Image"}</p>
          <p className="truncate font-mono text-[11px] text-text-muted">
            {[size && `${size.width} × ${size.height}`, name !== heading && name].filter(Boolean).join(" · ")}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {onSave && !markup && (
            <button type="button" className="btn" onClick={() => setMarkup(true)} disabled={!size}>
              Edit / Markup
            </button>
          )}
          <a className="btn" href={src} download={name || true}>
            Download
          </a>
          <button type="button" className="btn" onClick={() => void close()} disabled={saving} aria-label="Close" title="Close (Esc)">
            ✕
          </button>
        </div>
      </header>
      {editing && (
        <div role="toolbar" aria-label="Markup" className="flex flex-wrap items-center gap-2 border-b border-border-default px-5 py-1.5">
          <Segment on={tool === "draw"} label="Pen: a stylus or the mouse draws" onClick={() => setTool("draw")}>
            ✎ Pen
          </Segment>
          <Segment on={tool === "pan"} label="Move: a stylus or the mouse pans" onClick={() => setTool("pan")}>
            ✥ Move
          </Segment>
          <span aria-hidden className="mx-1 h-5 w-px bg-border-default" />
          {INKS.map((c) => (
            <button
              key={c.value}
              type="button"
              title={c.name}
              aria-label={c.name}
              aria-pressed={ink === c.value}
              onClick={() => {
                setInk(c.value);
                setTool("draw");
              }}
              className={`h-6 w-6 rounded-full border-2 ${ink === c.value ? "border-text-primary" : "border-transparent"}`}
              style={{ background: c.value }}
            />
          ))}
          <span aria-hidden className="mx-1 h-5 w-px bg-border-default" />
          {SIZES.map((s) => (
            <button
              key={s}
              type="button"
              title={`Line width ${s}`}
              aria-label={`Line width ${s}`}
              aria-pressed={lineSize === s}
              onClick={() => setLineSize(s)}
              className={`flex h-8 w-8 items-center justify-center rounded ${lineSize === s ? "bg-accent/[0.16]" : "hover:bg-surface-raised"}`}
            >
              <span className="rounded-full bg-text-primary" style={{ width: s + 2, height: s + 2 }} />
            </button>
          ))}
          <span aria-hidden className="mx-1 h-5 w-px bg-border-default" />
          <Segment on={false} label="Undo the last stroke" disabled={!strokes.length || saving} onClick={() => setStrokes((s) => s.slice(0, -1))}>
            Undo
          </Segment>
          <Segment on={false} label="Clear the markup" disabled={!strokes.length || saving} onClick={() => setStrokes([])}>
            Clear
          </Segment>
          <span className="ml-auto flex items-center gap-2">
            {saving && (
              <span role="status" className="text-xs text-text-muted">
                Saving…
              </span>
            )}
            <button type="button" className="btn" onClick={cancelMarkup} disabled={saving}>
              Cancel
            </button>
            <button type="button" className="btn-primary" onClick={() => void finishMarkup()} disabled={saving}>
              Save
            </button>
          </span>
        </div>
      )}
      {error && <p className="px-5 pt-2 text-[13px] text-accent">{error}</p>}
      <div
        ref={stageRef}
        className={`relative flex-1 touch-none select-none overflow-hidden ${editing && tool === "draw" ? "cursor-crosshair" : "cursor-grab active:cursor-grabbing"}`}
        onPointerDown={pointerDown}
        onPointerMove={pointerMove}
        onPointerUp={pointerUp}
        onPointerCancel={pointerUp}
        onDoubleClick={() => !editing && fit()}
      >
        <div
          className="absolute left-1/2 top-1/2"
          style={{
            width: size?.width,
            height: size?.height,
            transform: `translate(calc(-50% + ${view.x}px), calc(-50% + ${view.y}px)) scale(${view.zoom})`,
            visibility: size ? "visible" : "hidden",
          }}
        >
          <img
            ref={imageRef}
            src={src}
            alt={alt ?? ""}
            draggable={false}
            onLoad={(e) => {
              const { naturalWidth: width, naturalHeight: height } = e.currentTarget;
              // Fitted when first shown; a saved markup reloads the same image, at the same view.
              if (!size) setView({ zoom: fitZoom(width, height), x: 0, y: 0 });
              setSize({ width, height });
            }}
            className="block h-full w-full max-w-none shadow-lg"
          />
          {editing && size && (
            <canvas ref={canvasRef} width={canvasWidth} height={canvasHeight} className="absolute inset-0 h-full w-full" />
          )}
        </div>
      </div>
      <footer className="flex items-center justify-center gap-1 border-t border-border-default px-5 py-1.5">
        <Segment on={false} label="Zoom out" onClick={() => zoomTo(view.zoom / ZOOM_STEP)}>
          −
        </Segment>
        <span role="status" aria-label="Zoom" className="w-14 text-center font-mono text-xs text-text-secondary">
          {Math.round(view.zoom * 100)}%
        </span>
        <Segment on={false} label="Zoom in" onClick={() => zoomTo(view.zoom * ZOOM_STEP)}>
          +
        </Segment>
        <span aria-hidden className="mx-1 h-5 w-px bg-border-default" />
        <Segment on={false} label="Fit to the screen" onClick={fit}>
          Fit
        </Segment>
        <Segment on={false} label="Actual size" onClick={() => zoomTo(1)}>
          100%
        </Segment>
      </footer>
    </div>,
    document.body,
  );
}

const midpoint = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

/** Draw a stroke's segment ending at its `i`th point, at that point's width. */
function drawSegment(context: CanvasRenderingContext2D, stroke: Stroke, i: number) {
  const from = stroke.points[i - 1];
  const to = stroke.points[i];
  context.strokeStyle = stroke.color;
  context.lineWidth = to.width;
  context.lineCap = "round";
  context.lineJoin = "round";
  context.beginPath();
  context.moveTo(from.x, from.y);
  context.lineTo(to.x, to.y);
  context.stroke();
}

/** Draw a stroke's first point: a tap leaves a dot. */
function drawDot(context: CanvasRenderingContext2D, stroke: Stroke) {
  const { x, y, width } = stroke.points[0];
  context.fillStyle = stroke.color;
  context.beginPath();
  context.arc(x, y, width / 2, 0, Math.PI * 2);
  context.fill();
}

function Segment({
  on,
  label,
  disabled,
  onClick,
  children,
}: {
  on: boolean;
  label: string;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={on}
      disabled={disabled}
      onClick={onClick}
      className={`flex h-8 min-w-8 items-center justify-center rounded px-2 text-[13px] disabled:cursor-not-allowed disabled:opacity-40 ${
        on ? "bg-accent/[0.16] text-accent-soft" : "text-text-secondary hover:bg-surface-raised hover:text-text-primary"
      }`}
    >
      {children}
    </button>
  );
}

/** The button an image shows on hover, top right, to open it in the lightbox. */
export function ExpandButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      data-image-expand
      title="Expand"
      aria-label="Expand the image"
      onMouseDown={(e) => e.preventDefault()}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className="absolute right-2 top-2 z-[2] flex h-8 w-8 items-center justify-center rounded-md border border-border-strong bg-background/80 text-text-primary opacity-0 transition-opacity duration-150 hover:bg-surface-raised focus:opacity-100 group-hover:opacity-100"
    >
      <svg aria-hidden width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
        <path d="M8.5 1.5h4v4M12.5 1.5 8 6M5.5 12.5h-4v-4M1.5 12.5 6 8" />
      </svg>
    </button>
  );
}
