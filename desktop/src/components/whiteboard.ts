import type { PDFDocumentLoadingTask, PDFDocumentProxy } from "pdfjs-dist";

import { loadPdf, strokesByPage, type Comment, type MediaMarkup, type Stroke } from "./markupCore";

/**
 * A whiteboard, saved as JSON: in a note's body (a `type: whiteboard` note) or in a ```whiteboard fenced block in an
 * ordinary note. Its markup is the lightbox's (see markupCore), in world units, drawn over its floating elements:
 * images and PDF pages pinned on the canvas, stacked by `z` (higher is in front).
 *
 *   {"grid": true, "elements": [{"id": "…", "kind": "pdf", "src": "/api/notes/image/…", "page": 0, "x": 0, …}],
 *    "markup": {"strokes": [], "comments": []}}
 */
export type FloatingElement = {
  id: string;
  kind: "image" | "pdf";
  src: string;
  /** A PDF's page shown, counted from 0. */
  page?: number;
  x: number;
  y: number;
  w: number;
  h: number;
  z: number;
  /** How far it's turned about its center, in radians (clockwise on screen). */
  angle?: number;
};

export type WhiteboardState = {
  grid: boolean;
  elements: FloatingElement[];
  markup: MediaMarkup;
};

/** A whiteboard as it's edited: its markup's strokes and comments unpacked. */
export type WhiteboardDoc = {
  grid: boolean;
  elements: FloatingElement[];
  strokes: Stroke[];
  comments: Comment[];
};

export const EMPTY_WHITEBOARD: WhiteboardState = { grid: true, elements: [], markup: { strokes: [], comments: [] } };

const finite = (value: unknown, fallback: number) => (typeof value === "number" && Number.isFinite(value) ? value : fallback);

/** A whiteboard's JSON as a doc to edit. Anything unreadable is dropped rather than failing the whole board: a blank
 * or broken payload is an empty board. */
export function parseWhiteboard(json: string): WhiteboardDoc {
  let raw: Partial<WhiteboardState> | null = null;
  try {
    raw = json.trim() ? (JSON.parse(json) as Partial<WhiteboardState>) : null;
  } catch {
    raw = null;
  }
  if (!raw || typeof raw !== "object") raw = {};
  const elements = (Array.isArray(raw.elements) ? raw.elements : [])
    .filter((e): e is FloatingElement => !!e && typeof e === "object" && (e.kind === "image" || e.kind === "pdf") && typeof e.src === "string")
    .map((e, i) => ({
      id: typeof e.id === "string" && e.id ? e.id : `element-${i}`,
      kind: e.kind,
      src: e.src,
      ...(e.kind === "pdf" && { page: Math.max(0, Math.floor(finite(e.page, 0))) }),
      x: finite(e.x, 0),
      y: finite(e.y, 0),
      w: Math.max(1, finite(e.w, 320)),
      h: Math.max(1, finite(e.h, 240)),
      z: finite(e.z, i),
      ...(finite(e.angle, 0) ? { angle: finite(e.angle, 0) } : {}),
    }));
  const markup = raw.markup && typeof raw.markup === "object" ? raw.markup : { strokes: [], comments: [] };
  const strokes = [
    ...strokesByPage({ strokes: Array.isArray(markup.strokes) ? markup.strokes.filter(isStroke) : [], comments: [] }).values(),
  ].flat();
  const comments = (Array.isArray(markup.comments) ? markup.comments : [])
    .filter((c): c is Comment => !!c && typeof c === "object" && typeof c.id === "string" && typeof c.text === "string")
    .map((c) => ({ id: c.id, text: c.text, x: finite(c.x, 0), y: finite(c.y, 0), page: 0, isExpanded: false }));
  return { grid: raw.grid !== false, elements: normalizeZ(elements), strokes, comments };
}

/** Whether something read from a payload is drawable as a stroke. */
function isStroke(value: unknown): value is MediaMarkup["strokes"][number] {
  const s = value as Stroke | null;
  return (
    !!s &&
    typeof s === "object" &&
    typeof s.type === "string" &&
    typeof s.color === "string" &&
    Array.isArray(s.points) &&
    s.points.length > 0 &&
    s.points.every((p) => p && Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.width))
  );
}

/** Numbers rounded to hundredths of a unit: plenty for ink, and it keeps the saved JSON small. */
const round = (_key: string, value: unknown) => (typeof value === "number" ? Math.round(value * 100) / 100 : value);

/** A doc as its JSON: on one line, with no backtick in it, so it can sit in a fenced block. */
export function serializeWhiteboard(doc: WhiteboardDoc): string {
  const state: WhiteboardState = {
    grid: doc.grid,
    elements: normalizeZ(doc.elements),
    markup: { strokes: doc.strokes, comments: doc.comments.map((c) => ({ ...c, isExpanded: false, page: 0 })) },
  };
  return JSON.stringify(state, round).replace(/`/g, "\\u0060");
}

/** The elements back to front, their `z` renumbered 0, 1, 2… in that order. */
export function normalizeZ(elements: FloatingElement[]): FloatingElement[] {
  return [...elements]
    .sort((a, b) => a.z - b.z)
    .map((e, z) => (e.z === z ? e : { ...e, z }));
}

/** The elements with one moved a step forward (+1) or back (-1) in the stack, or right to the front or back. */
export function restack(elements: FloatingElement[], id: string, move: "forward" | "backward" | "front" | "back"): FloatingElement[] {
  const order = normalizeZ(elements);
  const from = order.findIndex((e) => e.id === id);
  if (from < 0) return elements;
  const to =
    move === "forward" ? Math.min(order.length - 1, from + 1) : move === "backward" ? Math.max(0, from - 1) : move === "front" ? order.length - 1 : 0;
  if (to === from) return elements;
  const [moved] = order.splice(from, 1);
  order.splice(to, 0, moved);
  return order.map((e, z) => (e.z === z ? e : { ...e, z }));
}

/**
 * PDFs open on whiteboards, shared by every element (and toolbar) showing one: loaded once, and let go a little after
 * the last of them is, so a remount (going fullscreen, say) doesn't load it again.
 */
const pdfDocs = new Map<string, { promise: Promise<PDFDocumentProxy>; task: Promise<PDFDocumentLoadingTask>; users: number; timer?: number }>();
const PDF_RELEASE_DELAY = 10_000;

export function acquirePdf(src: string): { promise: Promise<PDFDocumentProxy>; release: () => void } {
  let entry = pdfDocs.get(src);
  if (!entry) {
    const task = loadPdf(src);
    entry = { task, promise: task.then((loading) => loading.promise), users: 0 };
    // A PDF that failed to load is tried again next time.
    entry.promise.catch(() => pdfDocs.get(src) === entry && pdfDocs.delete(src));
    pdfDocs.set(src, entry);
  }
  const held = entry;
  held.users++;
  window.clearTimeout(held.timer);
  let released = false;
  return {
    promise: held.promise,
    release: () => {
      if (released) return;
      released = true;
      held.users--;
      if (held.users > 0) return;
      held.timer = window.setTimeout(() => {
        if (held.users > 0 || pdfDocs.get(src) !== held) return;
        pdfDocs.delete(src);
        void held.task.then((loading) => loading.destroy()).catch(() => {});
      }, PDF_RELEASE_DELAY);
    },
  };
}
