import type { PDFDocumentLoadingTask } from "pdfjs-dist";
import { getStroke } from "perfect-freehand";

/**
 * The markup engine shared by the media lightbox (strokes over an image or a PDF's page) and the whiteboard (strokes
 * over an infinite canvas): the stroke and comment schema, and drawing, hit-testing and transforming strokes. All of
 * it works in the surface's own units (an image's pixels, the whiteboard's world units); the caller sets the canvas's
 * transform and passes the `zoom` (screen pixels per unit) wherever screen-sized marks (handles, dashes) are drawn.
 */

export type Point = { x: number; y: number };
export type Tool = "draw" | "pan" | "select" | "erase" | "lasso-erase" | "line" | "arrow" | "rect" | "circle" | "text" | "comment";
export type Eraser = "erase" | "lasso-erase";
/** A markup stroke, in the surface's units; each point carries its line width. A freehand one ("draw") has a point
 * for each the pointer passed; a shape has two, where its drag started and where it is (or ended); a text has one, its
 * top left, whose width is its font size, and is turned by `angle` (in radians) about it. A freehand stroke with a
 * `taper` is drawn as perfect-freehand's outline, thinned by a pen's pressure (kept on each point) or by the pointer's
 * speed; one without (an older one, or a turned rectangle or ellipse) as a line whose width follows its points'.
 * The erasers leave no strokes: they delete the ones they touch (or loop around). */
export type Stroke = {
  type: Exclude<Tool, "pan" | "select" | "comment" | Eraser>;
  color: string;
  points: (Point & { width: number; pressure?: number })[];
  text?: string;
  angle?: number;
  taper?: "pen" | "speed";
};
/** A sticky-note comment pinned to a point on the surface (or a PDF's page, counted from 0), in its units. */
export type Comment = Point & { id: string; text: string; isExpanded: boolean; page: number };
/** `GET`/`PUT /api/notes/image/{name}/markup` (MediaMarkup in backend/schemas.py): the sidecar beside a file, and a
 * whiteboard's markup. An older sidecar may still hold eraser strokes, which are dropped when it's read (see
 * `strokesByPage`). */
export type MediaMarkup = { strokes: ((Stroke | (Omit<Stroke, "type"> & { type: Eraser })) & { page?: number })[]; comments: Comment[] };
/** A text being typed: where it goes, in surface units, its font size, in them too, its ink and what's typed so far. */
export type TextEntry = Point & { size: number; color: string; value: string };
/** A box, in surface units. */
export type Box = { left: number; top: number; right: number; bottom: number };
export type Corner = "nw" | "ne" | "se" | "sw";
/** What a drag on the selection does: move it, turn it, or scale it from one of its corners. */
export type Handle = "move" | "rotate" | Corner;
/** A drag transforming the selection: the strokes as they were when it started, as they are now (in `strokes`), the
 * box they were in, where it started, and the angle it's turned them by so far. */
export type Transform = { pointerId: number; handle: Handle; from: Point; box: Box; originals: Stroke[]; current: Stroke[]; angle: number };

export const isShape = (type: Tool) => type === "line" || type === "arrow" || type === "rect" || type === "circle";
export const isEraser = (type: Tool): type is Eraser => type === "erase" || type === "lasso-erase";

/** Ink that reads on most images, and on the whiteboard. */
export const INKS = [
  { name: "Red", value: "#ef4444" },
  { name: "Yellow", value: "#facc15" },
  { name: "Green", value: "#22c55e" },
  { name: "Blue", value: "#3b82f6" },
  { name: "Black", value: "#111111" },
  { name: "White", value: "#ffffff" },
];
/** Line widths, in screen pixels at the zoom a stroke is drawn at. */
export const SIZES = [2, 4, 8];
/** A text's font size, in screen pixels at the zoom it's placed at, for each line width. */
export const textSize = (lineSize: number) => 8 + lineSize * 3;
/** A text's font, at a size in pixels. */
export const textFont = (size: number) => `600 ${size}px "IBM Plex Sans", sans-serif`;
/** A canvas's limits, in device pixels: a larger one fails to allocate (and draws nothing) or eats memory. */
export const MAX_CANVAS_SIDE = 16384;
export const MAX_CANVAS_AREA = 4096 * 4096;
/** A PDF page's pixels per point, as browsers show PDFs at 100%. */
export const PDF_SCALE = 96 / 72;
/** How long a zoom rests before a PDF's page is rendered again at its resolution, in milliseconds. */
export const PDF_RENDER_DELAY = 150;
/** The selection's handles' size, and how far above its box the rotate handle sits, in screen pixels. */
export const HANDLE_SIZE = 9;
export const ROTATE_OFFSET = 24;
/** The least a corner's drag scales the selection to, so it can't collapse to nothing. */
const MIN_SCALE = 0.05;
/** The least the stroke eraser reaches from the pointer, in screen pixels, so the thinnest line size still hits ink. */
export const ERASER_MIN_REACH = 6;
/** The cursor over each of the selection's handles. */
export const HANDLE_CURSORS: Record<Handle, string> = {
  move: "cursor-move",
  rotate: "cursor-grab",
  nw: "cursor-nwse-resize",
  se: "cursor-nwse-resize",
  ne: "cursor-nesw-resize",
  sw: "cursor-nesw-resize",
};

/** Start loading a PDF with pdf.js, which (with its worker) is only fetched once one is opened. */
export async function loadPdf(url: string): Promise<PDFDocumentLoadingTask> {
  const [pdfjs, worker] = await Promise.all([import("pdfjs-dist"), import("pdfjs-dist/build/pdf.worker.min.mjs?url")]);
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  return pdfjs.getDocument({ url });
}

/** A fresh id, for a comment or a whiteboard's element. */
export const newId = () =>
  typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2);

/** A sidecar's strokes, by the page they're on. An older sidecar's eraser strokes (which once masked the ink under
 * them) are dropped: erasing now deletes strokes instead. */
export function strokesByPage(markup: MediaMarkup): Map<number, Stroke[]> {
  const byPage = new Map<number, Stroke[]>();
  for (const { page = 0, ...stroke } of markup.strokes) {
    if (isEraser(stroke.type)) continue;
    byPage.set(page, [...(byPage.get(page) ?? []), stroke as Stroke]);
  }
  return byPage;
}

/** Whether a key's going to a field being typed in. */
export const isTyping = (target: EventTarget | null) =>
  target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));

export const midpoint = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
export const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

/** Draw whole strokes, in surface units. */
export function drawStrokes(context: CanvasRenderingContext2D, strokes: Stroke[]) {
  for (const stroke of strokes) {
    if (isShape(stroke.type)) drawShape(context, stroke);
    else if (stroke.type === "text") drawText(context, stroke);
    else if (stroke.taper) drawFreehand(context, stroke);
    else {
      for (let i = 1; i < stroke.points.length; i++) drawSegment(context, stroke, i);
      if (stroke.points.length === 1) drawDot(context, stroke);
    }
  }
}

/** Set the context up to draw a stroke, in its ink. */
function inkFor(context: CanvasRenderingContext2D, stroke: Stroke) {
  context.strokeStyle = stroke.color;
  context.fillStyle = stroke.color;
  context.lineCap = "round";
  context.lineJoin = "round";
}

/** Draw a stroke's segment ending at its `i`th point, at that point's width. */
function drawSegment(context: CanvasRenderingContext2D, stroke: Stroke, i: number) {
  const from = stroke.points[i - 1];
  const to = stroke.points[i];
  inkFor(context, stroke);
  context.lineWidth = to.width;
  context.beginPath();
  context.moveTo(from.x, from.y);
  context.lineTo(to.x, to.y);
  context.stroke();
}

/** Draw a tapered freehand stroke as the polygon perfect-freehand outlines around its points, filled. */
function drawFreehand(context: CanvasRenderingContext2D, stroke: Stroke) {
  const pen = stroke.taper === "pen";
  const outline = getStroke(
    stroke.points.map((p) => [p.x, p.y, p.pressure ?? 0.5]),
    { size: stroke.points[0].width, thinning: 0.5, smoothing: 0.5, streamline: 0.5, simulatePressure: !pen },
  );
  if (!outline.length) return;
  inkFor(context, stroke);
  context.beginPath();
  outline.forEach(([x, y], i) => (i ? context.lineTo(x, y) : context.moveTo(x, y)));
  context.closePath();
  context.fill();
}

/** Draw a stroke's first point: a tap leaves a dot. */
function drawDot(context: CanvasRenderingContext2D, stroke: Stroke) {
  const { x, y, width } = stroke.points[0];
  inkFor(context, stroke);
  context.beginPath();
  context.arc(x, y, width / 2, 0, Math.PI * 2);
  context.fill();
}

/** Trace a lasso's loop, closed. */
function traceLasso(context: CanvasRenderingContext2D, points: Point[]) {
  context.beginPath();
  points.forEach(({ x, y }, i) => (i ? context.lineTo(x, y) : context.moveTo(x, y)));
  context.closePath();
}

/** Stroke the path traced dashed black on white, so it shows on any ink or image, and thin at any `zoom`. */
function strokeDashed(context: CanvasRenderingContext2D, zoom: number) {
  context.save();
  context.lineWidth = 1.5 / zoom;
  context.lineJoin = "round";
  context.strokeStyle = "#ffffff";
  context.stroke();
  context.setLineDash([4 / zoom, 4 / zoom]);
  context.strokeStyle = "#111111";
  context.stroke();
  context.restore();
}

/** Outline a lasso being drawn, at `zoom`. */
export function drawLassoOutline(context: CanvasRenderingContext2D, points: Point[], zoom: number) {
  traceLasso(context, points);
  strokeDashed(context, zoom);
}

/** Draw the selection's box, its corners' handles to scale it and (unless `rotatable` is false) the handle above it
 * to turn it, turned by `angle` about its center, at `zoom`. */
export function drawSelection(context: CanvasRenderingContext2D, box: Box, zoom: number, angle: number, rotatable = true) {
  const center = boxCenter(box);
  const rotateAt = rotateHandle(box, zoom);
  const size = HANDLE_SIZE / zoom;
  context.save();
  context.translate(center.x, center.y);
  context.rotate(angle);
  context.translate(-center.x, -center.y);
  context.beginPath();
  context.rect(box.left, box.top, box.right - box.left, box.bottom - box.top);
  if (rotatable) {
    context.moveTo(center.x, box.top);
    context.lineTo(rotateAt.x, rotateAt.y);
  }
  strokeDashed(context, zoom);
  context.lineWidth = 1.5 / zoom;
  context.fillStyle = "#ffffff";
  context.strokeStyle = "#111111";
  context.beginPath();
  for (const { x, y } of Object.values(boxCorners(box))) context.rect(x - size / 2, y - size / 2, size, size);
  if (rotatable) {
    context.moveTo(rotateAt.x + size / 2, rotateAt.y);
    context.arc(rotateAt.x, rotateAt.y, size / 2, 0, Math.PI * 2);
  }
  context.fill();
  context.stroke();
  context.restore();
}

/** Draw a text, from its top left, at its font size, turned by its angle about it. */
function drawText(context: CanvasRenderingContext2D, stroke: Stroke) {
  const { x, y, width: size } = stroke.points[0];
  inkFor(context, stroke);
  context.save();
  context.translate(x, y);
  context.rotate(stroke.angle ?? 0);
  context.font = textFont(size);
  context.textBaseline = "top";
  context.fillText(stroke.text ?? "", 0, 0);
  context.restore();
}

/** A text's width, in the pixels its size is in. */
let measure: CanvasRenderingContext2D | null = null;
export function textWidth(text: string, size: number): number {
  measure ??= document.createElement("canvas").getContext("2d");
  if (!measure) return text.length * size;
  measure.font = textFont(size);
  return measure.measureText(text).width;
}

/** Draw a shape, from its start point to its end. */
function drawShape(context: CanvasRenderingContext2D, stroke: Stroke) {
  const [start, end] = stroke.points;
  if (!end) return;
  inkFor(context, stroke);
  context.lineWidth = start.width;
  context.beginPath();
  if (stroke.type === "rect") {
    context.rect(start.x, start.y, end.x - start.x, end.y - start.y);
  } else if (stroke.type === "circle") {
    // The ellipse that fills the box the drag spans.
    const center = midpoint(start, end);
    context.ellipse(center.x, center.y, Math.abs(end.x - start.x) / 2, Math.abs(end.y - start.y) / 2, 0, 0, Math.PI * 2);
  } else {
    context.moveTo(start.x, start.y);
    context.lineTo(end.x, end.y);
    if (stroke.type === "arrow") {
      // The head: a barb either side of the line, back from its end, sized to its width but at most half its length.
      const angle = Math.atan2(end.y - start.y, end.x - start.x);
      const head = Math.min(distance(start, end) / 2, start.width * 5);
      for (const side of [-1, 1]) {
        context.moveTo(end.x, end.y);
        context.lineTo(end.x - head * Math.cos(angle + (side * Math.PI) / 6), end.y - head * Math.sin(angle + (side * Math.PI) / 6));
      }
    }
  }
  context.stroke();
}

/** The points that outline a stroke, in surface units: a freehand one's own, a shape's corners (or, for an ellipse,
 * `segments` points around it), a line's ends and middle, and a text's box's corners. */
function outline(stroke: Stroke, segments = 8): Point[] {
  const [start, end] = stroke.points;
  if (stroke.type === "text") {
    const size = start.width;
    const width = textWidth(stroke.text ?? "", size);
    const cos = Math.cos(stroke.angle ?? 0);
    const sin = Math.sin(stroke.angle ?? 0);
    return [[0, 0], [width, 0], [width, size], [0, size]].map(([u, v]) => ({ x: start.x + u * cos - v * sin, y: start.y + u * sin + v * cos }));
  }
  if (!isShape(stroke.type) || !end) return stroke.points;
  if (stroke.type === "rect") return [start, { x: end.x, y: start.y }, end, { x: start.x, y: end.y }];
  if (stroke.type === "circle") {
    const center = midpoint(start, end);
    const rx = Math.abs(end.x - start.x) / 2;
    const ry = Math.abs(end.y - start.y) / 2;
    return Array.from({ length: segments }, (_, i) => {
      const a = (i / segments) * Math.PI * 2;
      return { x: center.x + rx * Math.cos(a), y: center.y + ry * Math.sin(a) };
    });
  }
  return [start, midpoint(start, end), end];
}

/** Whether a point is inside a loop (ray casting: a ray from it crosses the loop's edges an odd number of times). */
function insideLoop({ x, y }: Point, loop: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
    const a = loop[i];
    const b = loop[j];
    if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** Whether a lasso's loop picks a stroke: whether it encloses all of its outline (an ellipse's checked all round),
 * so one it only crosses, or mostly encloses, is left out. */
export function lassoed(stroke: Stroke, loop: Point[]): boolean {
  return outline(stroke, 48).every((p) => insideLoop(p, loop));
}

/** How far a point is from the segment between `a` and `b`. */
function segmentDistance(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = dx * dx + dy * dy;
  const t = length ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / length)) : 0;
  return distance(p, { x: a.x + t * dx, y: a.y + t * dy });
}

/** Whether a stroke's ink is within `reach` of a point: a text's anywhere over its box, any other's along its line
 * (a rectangle's or ellipse's closed), widened by half its width. */
export function touches(stroke: Stroke, point: Point, reach: number): boolean {
  const points = outline(stroke, 48);
  const closed = stroke.type === "text" || stroke.type === "rect" || stroke.type === "circle";
  if (stroke.type === "text" && insideLoop(point, points)) return true;
  const near = reach + (stroke.type === "text" ? 0 : Math.max(...stroke.points.map((p) => p.width)) / 2);
  if (points.length === 1) return distance(point, points[0]) <= near;
  const segments = closed ? points.length : points.length - 1;
  for (let i = 0; i < segments; i++) if (segmentDistance(point, points[i], points[(i + 1) % points.length]) <= near) return true;
  return false;
}

/** The box around strokes' ink. */
export function selectionBox(strokes: Stroke[]): Box {
  const box = { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity };
  for (const stroke of strokes) {
    // A text's box is its ink's; a line's is half its width wider all round.
    const pad = stroke.type === "text" ? 0 : Math.max(...stroke.points.map((p) => p.width)) / 2;
    for (const { x, y } of outline(stroke)) {
      box.left = Math.min(box.left, x - pad);
      box.top = Math.min(box.top, y - pad);
      box.right = Math.max(box.right, x + pad);
      box.bottom = Math.max(box.bottom, y + pad);
    }
  }
  return box;
}

export const boxCenter = (box: Box): Point => ({ x: (box.left + box.right) / 2, y: (box.top + box.bottom) / 2 });
export const boxCorners = (box: Box): Record<Corner, Point> => ({
  nw: { x: box.left, y: box.top },
  ne: { x: box.right, y: box.top },
  se: { x: box.right, y: box.bottom },
  sw: { x: box.left, y: box.bottom },
});
export const OPPOSITE: Record<Corner, Corner> = { nw: "se", ne: "sw", se: "nw", sw: "ne" };
/** Where the handle that turns the selection is: above its box's middle, at `zoom`. */
const rotateHandle = (box: Box, zoom: number): Point => ({ x: (box.left + box.right) / 2, y: box.top - ROTATE_OFFSET / zoom });

/** The selection's handle at a point, at `zoom`: the rotate handle (unless `rotatable` is false), a corner, or its
 * box, to move it; or none. */
export function selectionHandle(box: Box, point: Point, zoom: number, rotatable = true): Handle | null {
  const reach = HANDLE_SIZE / zoom;
  if (rotatable && distance(point, rotateHandle(box, zoom)) <= reach) return "rotate";
  for (const [corner, at] of Object.entries(boxCorners(box)) as [Corner, Point][]) {
    if (distance(point, at) <= reach) return corner;
  }
  const inside = point.x >= box.left && point.x <= box.right && point.y >= box.top && point.y <= box.bottom;
  return inside ? "move" : null;
}

/** A stroke with each point mapped by `map` and its width scaled by `scale`, and, if it's a text, turned by `angle`. */
function mapStroke(stroke: Stroke, map: (p: Point) => Point, scale = 1, angle = 0): Stroke {
  const points = stroke.points.map((p) => ({ ...p, ...map(p), width: p.width * scale }));
  return stroke.type === "text" ? { ...stroke, points, angle: (stroke.angle ?? 0) + angle } : { ...stroke, points };
}

/** A rectangle or ellipse as the freehand line around it, which, unlike the shape, can be turned; any other stroke
 * as it is. */
function asPath(stroke: Stroke): Stroke {
  if (stroke.type !== "rect" && stroke.type !== "circle") return stroke;
  const points = outline(stroke, 48);
  const width = stroke.points[0].width;
  return { type: "draw", color: stroke.color, points: [...points, points[0]].map((p) => ({ ...p, width })) };
}

/** The strokes as a drag of the selection's `handle`, from `from` to `to`, leaves them, given the box they were in
 * when it started: moved by it, turned about the box's center (by the angle returned), or scaled, evenly, from the
 * corner opposite the one dragged. */
export function transformStrokes(strokes: Stroke[], box: Box, handle: Handle, from: Point, to: Point): { strokes: Stroke[]; angle: number } {
  if (handle === "move") {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    return { strokes: strokes.map((s) => mapStroke(s, (p) => ({ x: p.x + dx, y: p.y + dy }))), angle: 0 };
  }
  if (handle === "rotate") {
    const center = boxCenter(box);
    const angle = Math.atan2(to.y - center.y, to.x - center.x) - Math.atan2(from.y - center.y, from.x - center.x);
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const turn = (p: Point) => ({
      x: center.x + (p.x - center.x) * cos - (p.y - center.y) * sin,
      y: center.y + (p.x - center.x) * sin + (p.y - center.y) * cos,
    });
    return { strokes: strokes.map((s) => mapStroke(asPath(s), turn, 1, angle)), angle };
  }
  const scale = cornerScale(box, handle, from, to);
  const anchor = boxCorners(box)[OPPOSITE[handle]];
  const grow = (p: Point) => ({ x: anchor.x + (p.x - anchor.x) * scale, y: anchor.y + (p.y - anchor.y) * scale });
  return { strokes: strokes.map((s) => mapStroke(s, grow, scale)), angle: 0 };
}

/** How much a drag of a box's corner, from `from` to `to`, scales it, evenly, from the opposite corner: how far
 * along the box's diagonal the dragged corner has gone, at least `min`. */
export function cornerScale(box: Box, corner: Corner, from: Point, to: Point, min = MIN_SCALE): number {
  const corners = boxCorners(box);
  const anchor = corners[OPPOSITE[corner]];
  const diagonal = { x: corners[corner].x - anchor.x, y: corners[corner].y - anchor.y };
  const length = diagonal.x ** 2 + diagonal.y ** 2;
  if (!length) return 1;
  const dragged = { x: corners[corner].x + to.x - from.x - anchor.x, y: corners[corner].y + to.y - from.y - anchor.y };
  return Math.max(min, (dragged.x * diagonal.x + dragged.y * diagonal.y) / length);
}
