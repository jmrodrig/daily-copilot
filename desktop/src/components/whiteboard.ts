import type { PDFDocumentLoadingTask, PDFDocumentProxy } from "pdfjs-dist";

import { loadPdf, strokesByPage, type Comment, type MediaMarkup, type Stroke } from "./markupCore";

/**
 * A whiteboard, saved as JSON: in a note's body (a `type: whiteboard` note) or in a ```whiteboard fenced block in an
 * ordinary note. Its markup is the lightbox's (see markupCore), in world units, drawn over its floating elements:
 * images and PDF pages pinned on the canvas, stacked by `z` (higher is in front).
 *
 *   {"grid": true, "elements": [{"id": "…", "kind": "pdf", "src": "/api/notes/image/…", "page": 0, "x": 0, …}],
 *    "markup": {"strokes": [], "comments": []}, "lockedLayers": [{"id": "…", "name": "Locked Layer 1", "elements": [], "strokes": []}]}
 *
 * Locked layers hold strokes and elements set into the background: drawn behind the rest, and out of reach of the
 * tools till they're unlocked.
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

/** Strokes and floating elements locked into the board's background, together. */
export type LockedLayer = { id: string; name: string; elements: FloatingElement[]; strokes: Stroke[] };

export type WhiteboardState = {
  grid: boolean;
  elements: FloatingElement[];
  markup: MediaMarkup;
  lockedLayers?: LockedLayer[];
};

/** A whiteboard as it's edited: its markup's strokes and comments unpacked. */
export type WhiteboardDoc = {
  grid: boolean;
  elements: FloatingElement[];
  strokes: Stroke[];
  comments: Comment[];
  lockedLayers?: LockedLayer[];
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
  const elements = parseElements(raw.elements, "element");
  const markup = raw.markup && typeof raw.markup === "object" ? raw.markup : { strokes: [], comments: [] };
  const strokes = parseStrokes(markup.strokes);
  const comments = (Array.isArray(markup.comments) ? markup.comments : [])
    .filter((c): c is Comment => !!c && typeof c === "object" && typeof c.id === "string" && typeof c.text === "string")
    .map((c) => ({ id: c.id, text: c.text, x: finite(c.x, 0), y: finite(c.y, 0), page: 0, isExpanded: false }));
  const lockedLayers = (Array.isArray(raw.lockedLayers) ? raw.lockedLayers : [])
    .filter((l): l is LockedLayer => !!l && typeof l === "object")
    .map((l, i) => ({
      id: typeof l.id === "string" && l.id ? l.id : `layer-${i}`,
      name: typeof l.name === "string" && l.name ? l.name : `Locked Layer ${i + 1}`,
      elements: parseElements(l.elements, `layer-${i}-element`),
      strokes: parseStrokes(l.strokes),
    }))
    .filter((l) => l.elements.length || l.strokes.length);
  return { grid: raw.grid !== false, elements, strokes, comments, ...(lockedLayers.length > 0 && { lockedLayers }) };
}

/** The floating elements read from a payload, stacked back to front; one without an id gets one from `fallbackId`. */
function parseElements(value: unknown, fallbackId: string): FloatingElement[] {
  const elements = (Array.isArray(value) ? (value as FloatingElement[]) : [])
    .filter((e): e is FloatingElement => !!e && typeof e === "object" && (e.kind === "image" || e.kind === "pdf") && typeof e.src === "string")
    .map((e, i) => ({
      id: typeof e.id === "string" && e.id ? e.id : `${fallbackId}-${i}`,
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
  return normalizeZ(elements);
}

/** The drawable strokes read from a payload (erasers' and pages dropped). */
function parseStrokes(value: unknown): Stroke[] {
  return [...strokesByPage({ strokes: Array.isArray(value) ? value.filter(isStroke) : [], comments: [] }).values()].flat();
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
    ...(!!doc.lockedLayers?.length && {
      lockedLayers: doc.lockedLayers.map((l) => ({ id: l.id, name: l.name, elements: normalizeZ(l.elements), strokes: l.strokes })),
    }),
  };
  return JSON.stringify(state, round).replace(/`/g, "\\u0060");
}

/** The elements back to front, their `z` renumbered 0, 1, 2… in that order. */
export function normalizeZ(elements: FloatingElement[]): FloatingElement[] {
  return [...elements]
    .sort((a, b) => a.z - b.z)
    .map((e, z) => (e.z === z ? e : { ...e, z }));
}

/** The elements with those picked (by id) moved a step forward or back in the stack, each past the next one not
 * picked, or right to the front or back; the picked keep their order among themselves. */
export function restack(elements: FloatingElement[], ids: Set<string>, move: "forward" | "backward" | "front" | "back"): FloatingElement[] {
  let order = normalizeZ(elements);
  const picked = (e: FloatingElement) => ids.has(e.id);
  if (move === "front") order = [...order.filter((e) => !picked(e)), ...order.filter(picked)];
  else if (move === "back") order = [...order.filter(picked), ...order.filter((e) => !picked(e))];
  else if (move === "forward") {
    // From the top down, so a run of picked ones at the front stays there.
    for (let i = order.length - 2; i >= 0; i--) {
      if (picked(order[i]) && !picked(order[i + 1])) [order[i], order[i + 1]] = [order[i + 1], order[i]];
    }
  } else {
    for (let i = 1; i < order.length; i++) {
      if (picked(order[i]) && !picked(order[i - 1])) [order[i], order[i - 1]] = [order[i - 1], order[i]];
    }
  }
  const next = order.map((e, z) => (e.z === z ? e : { ...e, z }));
  return next.every((e, i) => e === elements[i]) && next.length === elements.length ? elements : next;
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
