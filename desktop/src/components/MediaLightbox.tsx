import type { PDFDocumentLoadingTask, PDFDocumentProxy, RenderTask } from "pdfjs-dist";
import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { getStroke } from "perfect-freehand";

import { getJson, message, sendJson } from "../lib/api";

/** The view: the image's scale (1 is its natural size) and its center's offset from the stage's, in screen pixels. */
type View = { zoom: number; x: number; y: number };
type Point = { x: number; y: number };
type Tool = "draw" | "pan" | "select" | "erase" | "lasso-erase" | "line" | "arrow" | "rect" | "circle" | "text" | "comment";
type Eraser = "erase" | "lasso-erase";
/** A markup stroke, in image pixels; each point carries its line width. A freehand one ("draw") has a point for each
 * the pointer passed; a shape has two, where its drag started and where it is (or ended); a text has one, its top
 * left, whose width is its font size, and is turned by `angle` (in radians) about it. A freehand stroke with a `taper`
 * is drawn as perfect-freehand's outline, thinned by a pen's pressure (kept on each point) or by the pointer's speed;
 * one without (an older one, or a turned rectangle or ellipse) as a line whose width follows its points'.
 * The erasers leave no strokes: they delete the ones they touch (or loop around). */
type Stroke = {
  type: Exclude<Tool, "pan" | "select" | "comment" | Eraser>;
  color: string;
  points: (Point & { width: number; pressure?: number })[];
  text?: string;
  angle?: number;
  taper?: "pen" | "speed";
};
/** A sticky-note comment pinned to a point on the image or a PDF's page (counted from 0), in its pixels. */
type Comment = Point & { id: string; text: string; isExpanded: boolean; page: number };
/** `GET`/`PUT /api/notes/image/{name}/markup` (MediaMarkup in backend/schemas.py): the sidecar beside the file. An
 * older one may still hold eraser strokes, which are dropped when it's read (see `strokesByPage`). */
export type MediaMarkup = { strokes: ((Stroke | (Omit<Stroke, "type"> & { type: Eraser })) & { page?: number })[]; comments: Comment[] };
/** A text being typed: where it goes, in image pixels, its font size, in them too, its ink and what's typed so far. */
type TextEntry = Point & { size: number; color: string; value: string };
/** A box, in image pixels. */
type Box = { left: number; top: number; right: number; bottom: number };
type Corner = "nw" | "ne" | "se" | "sw";
/** What a drag on the selection does: move it, turn it, or scale it from one of its corners. */
type Handle = "move" | "rotate" | Corner;
/** A drag transforming the selection: the strokes as they were when it started, as they are now (in `strokes`), the
 * box they were in, where it started, and the angle it's turned them by so far. */
type Transform = { pointerId: number; handle: Handle; from: Point; box: Box; originals: Stroke[]; current: Stroke[]; angle: number };

const isShape = (type: Tool) => type === "line" || type === "arrow" || type === "rect" || type === "circle";
const isEraser = (type: Tool): type is Eraser => type === "erase" || type === "lasso-erase";

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
/** A text's font size, in screen pixels at the zoom it's placed at, for each line width. */
const textSize = (lineSize: number) => 8 + lineSize * 3;
/** A text's font, at a size in pixels. */
const textFont = (size: number) => `600 ${size}px "IBM Plex Sans", sans-serif`;
/** The markup canvas's limits, in device pixels: a larger one fails to allocate (and draws nothing) or eats memory. */
const MAX_CANVAS_SIDE = 16384;
const MAX_CANVAS_AREA = 4096 * 4096;
/** A PDF page's pixels per point, as browsers show PDFs at 100%. */
const PDF_SCALE = 96 / 72;
/** How long a zoom rests before a PDF's page is rendered again at its resolution, in milliseconds. */
const PDF_RENDER_DELAY = 150;
/** The selection's handles' size, and how far above its box the rotate handle sits, in screen pixels. */
const HANDLE_SIZE = 9;
const ROTATE_OFFSET = 24;
/** The least a corner's drag scales the selection to, so it can't collapse to nothing. */
const MIN_SCALE = 0.05;
/** The cursor over each of the selection's handles. */
const HANDLE_CURSORS: Record<Handle, string> = {
  move: "cursor-move",
  rotate: "cursor-grab",
  nw: "cursor-nwse-resize",
  se: "cursor-nwse-resize",
  ne: "cursor-nesw-resize",
  sw: "cursor-nesw-resize",
};

/** Whether a URL is a PDF's, by its name. */
export const isPdfUrl = (url: string) => /\.pdf$/i.test(new URL(url, window.location.href).pathname);

/** A stored file's markup sidecar's URL (in the same space), or null for a file that isn't stored in one. */
export function markupUrlOf(src: string): string | null {
  const url = new URL(src, window.location.href);
  if (url.origin !== window.location.origin || !/^\/api\/notes\/image\/[^/]+$/.test(url.pathname)) return null;
  return `${url.pathname}/markup${url.search}`;
}

/** Start loading a PDF with pdf.js, which (with its worker) is only fetched once one is opened. */
async function loadPdf(url: string): Promise<PDFDocumentLoadingTask> {
  const [pdfjs, worker] = await Promise.all([import("pdfjs-dist"), import("pdfjs-dist/build/pdf.worker.min.mjs?url")]);
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  return pdfjs.getDocument({ url });
}

/** The sidecar holding strokes kept by page (the image's are page 0's) and comments; a comment's open state isn't
 * kept, so opening one doesn't count as a change. */
function snapshot(byPage: Map<number, Stroke[]>, comments: Comment[]): MediaMarkup {
  return {
    strokes: [...byPage].sort(([a], [b]) => a - b).flatMap(([page, list]) => list.map((s) => ({ ...s, page }))),
    comments: comments.map((c) => ({ ...c, isExpanded: false })),
  };
}

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

/**
 * A note's image or PDF, fullscreen: dragged to pan and zoomed with the wheel, a pinch or the footer's controls; a
 * PDF is rendered with pdf.js, a page at a time. A stored file's markup, the strokes and comments drawn over it, is
 * kept beside it in a JSON sidecar, never in the file, and shown over it. While `editable`, it can be marked up: a
 * canvas over the file takes a stylus's (or, with the pen tool, the mouse's) strokes, while touch still pans and
 * pinch-zooms, and the comment tool pins a sticky note where it's clicked. Saving, or closing or leaving markup, puts
 * the sidecar, and Cancel goes back to it as it was.
 */
export default function MediaLightbox({
  src,
  alt,
  title,
  onClose,
  editable = false,
}: {
  src: string;
  alt?: string | null;
  title?: string | null;
  onClose: () => void;
  editable?: boolean;
}) {
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pdfCanvasRef = useRef<HTMLCanvasElement>(null);
  const isPdf = isPdfUrl(src);
  const markupUrl = markupUrlOf(src);
  // The PDF, once it's loaded, its page shown (counted from 0) and how many it has.
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [page, setPage] = useState(0);
  const pageRef = useRef(page);
  pageRef.current = page;
  // The size of the image, or the PDF's page, in its pixels.
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const [view, setView] = useState<View>({ zoom: 1, x: 0, y: 0 });
  const viewRef = useRef(view);
  viewRef.current = view;
  const [markup, setMarkup] = useState(false);
  const [tool, setTool] = useState<Tool>("draw");
  const toolRef = useRef(tool);
  toolRef.current = tool;
  // The eraser the toolbar's eraser button (and Shift) picks, and whether its menu, to pick the other, is open.
  const [eraser, setEraser] = useState<Eraser>("lasso-erase");
  const eraserRef = useRef(eraser);
  eraserRef.current = eraser;
  const [eraserMenu, setEraserMenu] = useState(false);
  const eraserMenuRef = useRef<HTMLSpanElement>(null);
  const [ink, setInk] = useState(INKS[0].value);
  const [lineSize, setLineSize] = useState(SIZES[1]);
  // The strokes on the page shown (an image's all are), the other pages' strokes, and the comments on every page.
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const otherPages = useRef(new Map<number, Stroke[]>());
  const [comments, setComments] = useState<Comment[]>([]);
  // The sidecar as last loaded or saved, to tell whether there's anything to save and to go back to on Cancel; and
  // whether it's loaded, before which the markup can't be edited (a save would overwrite what's there).
  const saved = useRef(JSON.stringify(snapshot(new Map(), [])));
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The pointers down on the stage, where they last were: one pans, two pinch.
  const pointers = useRef(new Map<number, Point>());
  // The stroke being drawn, and the pointer drawing it.
  const drawing = useRef<{ pointerId: number; stroke: Stroke } | null>(null);
  // The stroke eraser's drag: the pointer, and how near it a stroke must pass to be deleted, in image pixels.
  const erasing = useRef<{ pointerId: number; reach: number } | null>(null);
  // The text being typed, if one is; the ref is cleared as soon as it's finished, so it's only finished once.
  const [textEntry, setTextEntry] = useState<TextEntry | null>(null);
  const textEntryRef = useRef(textEntry);
  textEntryRef.current = textEntry;
  const textInputRef = useRef<HTMLInputElement>(null);
  // The tool Shift swapped for the eraser, while it's held.
  const shiftFrom = useRef<Tool | null>(null);
  // The strokes the select tool picked (those of them still in `strokes`), the lasso picking them (or, for the lasso
  // eraser, deleting them) as it's drawn, the drag transforming them, and the handle the pointer is over.
  const [selected, setSelected] = useState<Set<Stroke>>(() => new Set());
  const selection = strokes.filter((s) => selected.has(s));
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  const selecting = useRef<{ pointerId: number; points: Point[]; erase: boolean } | null>(null);
  const transforming = useRef<Transform | null>(null);
  const [hover, setHover] = useState<Handle | null>(null);

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

  /** Show a sidecar's markup, on the page shown. */
  function hydrate(markup: MediaMarkup) {
    const byPage = strokesByPage(markup);
    setStrokes(byPage.get(pageRef.current) ?? []);
    byPage.delete(pageRef.current);
    otherPages.current = byPage;
    setComments(markup.comments.map((c) => ({ ...c, isExpanded: false })));
    setSelected(new Set());
  }

  // The sidecar's loaded once, when the lightbox opens.
  useEffect(() => {
    if (!markupUrl) return setLoaded(true);
    const controller = new AbortController();
    getJson<MediaMarkup>(markupUrl, controller.signal).then(
      (markup) => {
        hydrate(markup);
        // As `current()` will put it, so it only counts as changed once it is.
        saved.current = JSON.stringify(snapshot(strokesByPage(markup), markup.comments));
        setLoaded(true);
      },
      (err) => !controller.signal.aborted && setError(`Could not load the markup (${message(err)}).`),
    );
    return () => controller.abort();
  }, [markupUrl]);

  /** The markup as it is now, every page's. */
  function current(): MediaMarkup {
    return snapshot(new Map([...otherPages.current, [page, strokes]]), comments);
  }

  /** Put the markup in its sidecar, if it changed; whether it went (or there was nothing to put). */
  async function save(): Promise<boolean> {
    if (!markupUrl || !loaded) return true;
    const markup = current();
    const json = JSON.stringify(markup);
    if (json === saved.current) return true;
    setSaving(true);
    setError(null);
    try {
      await sendJson("PUT", markupUrl, markup);
      saved.current = json;
      return true;
    } catch (err) {
      setError(`Could not save the markup (${message(err)}).`);
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
    cancelText();
    hydrate(JSON.parse(saved.current) as MediaMarkup);
    setError(null);
    setMarkup(false);
  }

  /** Show a PDF's page (counted from 0), keeping the strokes on the one that was shown. */
  function goToPage(next: number) {
    if (!pdf || next < 0 || next >= pdf.numPages || next === page) return;
    commitText();
    otherPages.current.set(page, strokes);
    setStrokes(otherPages.current.get(next) ?? []);
    otherPages.current.delete(next);
    setSelected(new Set());
    setPage(next);
  }

  /** Close the open comments: one never written in goes. */
  function collapseComments() {
    setComments((all) => all.filter((c) => !c.isExpanded || c.text.trim()).map((c) => ({ ...c, isExpanded: false })));
  }

  /** Escape: drop the text being typed, or close the eraser's menu or the open comments, or drop the selection, or
   * else the lightbox. */
  function escape() {
    if (textEntryRef.current) cancelText();
    else if (eraserMenu) setEraserMenu(false);
    else if (comments.some((c) => c.isExpanded)) collapseComments();
    else if (selection.length && !transforming.current) setSelected(new Set());
    else void close();
  }

  /** Swap strokes for others (a transformed or recoloured one for each), keeping them selected. */
  function replaceStrokes(next: Map<Stroke, Stroke>) {
    setStrokes((all) => all.map((s) => next.get(s) ?? s));
    setSelected((picked) => new Set([...picked].map((s) => next.get(s) ?? s)));
  }

  // The latest `escape`, for the key handler.
  const escapeRef = useRef(escape);
  escapeRef.current = escape;
  useEffect(() => {
    const keydown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        escapeRef.current();
      }
    };
    window.addEventListener("keydown", keydown, true);
    return () => window.removeEventListener("keydown", keydown, true);
  }, []);

  // A file that isn't stored in the space has nowhere to keep its markup.
  const canMarkup = editable && !!markupUrl && loaded;
  const editing = markup && canMarkup;

  // A PDF's loaded when the lightbox opens, and let go when it closes.
  useEffect(() => {
    if (!isPdf) return;
    let cancelled = false;
    let task: PDFDocumentLoadingTask | null = null;
    loadPdf(src)
      .then((loading) => {
        task = loading;
        if (cancelled) void loading.destroy();
        return loading.promise;
      })
      .then(
        (doc) => !cancelled && setPdf(doc),
        (err) => !cancelled && setError(`Could not open the PDF (${message(err)}).`),
      );
    return () => {
      cancelled = true;
      void task?.destroy();
    };
  }, [src, isPdf]);

  // A PDF's page is sized, and fitted, when it's shown.
  useEffect(() => {
    if (!pdf) return;
    let cancelled = false;
    pdf.getPage(page + 1).then(
      (pdfPage) => {
        if (cancelled) return;
        const { width, height } = pdfPage.getViewport({ scale: PDF_SCALE });
        setView({ zoom: fitZoom(width, height), x: 0, y: 0 });
        setSize({ width, height });
      },
      (err) => !cancelled && setError(`Could not show page ${page + 1} (${message(err)}).`),
    );
    return () => {
      cancelled = true;
    };
  }, [pdf, page]);

  // A PDF's page is rendered at the markup canvas's resolution, so it stays sharp as it's zoomed in: off screen, then
  // copied over, so it doesn't flash blank. A zoom renders it again once it rests; till then it's scaled as it was.
  useEffect(() => {
    const shown = pdfCanvasRef.current;
    if (!pdf || !size || !shown) return;
    let cancelled = false;
    let task: RenderTask | null = null;
    const render = async () => {
      try {
        const pdfPage = await pdf.getPage(page + 1);
        if (cancelled) return;
        const offscreen = document.createElement("canvas");
        offscreen.width = canvasWidth;
        offscreen.height = canvasHeight;
        task = pdfPage.render({ canvas: offscreen, viewport: pdfPage.getViewport({ scale: (PDF_SCALE * canvasWidth) / size.width }) });
        await task.promise;
        if (cancelled) return;
        shown.width = offscreen.width;
        shown.height = offscreen.height;
        shown.getContext("2d")?.drawImage(offscreen, 0, 0);
        shown.dataset.page = String(page);
      } catch (err) {
        if (!cancelled) setError(`Could not show page ${page + 1} (${message(err)}).`);
      }
    };
    // The first render of a page isn't held back: there's nothing to show till it's done.
    const timer = setTimeout(() => void render(), shown.dataset.page === String(page) ? PDF_RENDER_DELAY : 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      task?.cancel();
    };
  }, [pdf, page, size, canvasWidth, canvasHeight]);

  // Holding Shift in markup swaps the tool for the eraser, and letting go swaps it back (unless another was picked
  // meanwhile). Not while typing, where Shift is for capitals.
  useEffect(() => {
    if (!editing) return;
    const release = () => {
      const from = shiftFrom.current;
      shiftFrom.current = null;
      if (from && isEraser(toolRef.current)) setTool(from);
    };
    const keydown = (e: KeyboardEvent) => {
      if (e.key !== "Shift" || e.repeat || shiftFrom.current || isTyping(e.target) || isEraser(toolRef.current)) return;
      shiftFrom.current = toolRef.current;
      setTool(eraserRef.current);
    };
    const keyup = (e: KeyboardEvent) => e.key === "Shift" && release();
    window.addEventListener("keydown", keydown);
    window.addEventListener("keyup", keyup);
    // Shift let go in another window never comes up here.
    window.addEventListener("blur", release);
    return () => {
      window.removeEventListener("keydown", keydown);
      window.removeEventListener("keyup", keyup);
      window.removeEventListener("blur", release);
      release();
    };
  }, [editing]);

  // Delete or Backspace deletes the selection (once it's done being dragged). Not while typing.
  useEffect(() => {
    if (!editing) return;
    const keydown = (e: KeyboardEvent) => {
      if ((e.key !== "Delete" && e.key !== "Backspace") || isTyping(e.target) || transforming.current) return;
      const gone = new Set(selectionRef.current);
      if (!gone.size) return;
      e.preventDefault();
      setStrokes((s) => s.filter((stroke) => !gone.has(stroke)));
      setSelected(new Set());
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [editing]);

  // The selection is the select tool's: another tool drops it.
  useEffect(() => {
    if (tool === "select") return;
    setSelected(new Set());
    setHover(null);
  }, [tool]);

  // The eraser's menu closes on a click outside it.
  useEffect(() => {
    if (!eraserMenu) return;
    const outside = (e: PointerEvent) => {
      if (!eraserMenuRef.current?.contains(e.target as Node)) setEraserMenu(false);
    };
    window.addEventListener("pointerdown", outside, true);
    return () => window.removeEventListener("pointerdown", outside, true);
  }, [eraserMenu]);

  // A text's field takes the focus once the click that placed it is done: the click's own mousedown would blur it.
  const textAt = textEntry && `${textEntry.x},${textEntry.y}`;
  useEffect(() => {
    if (!textAt) return;
    const timer = setTimeout(() => textInputRef.current?.focus());
    return () => clearTimeout(timer);
  }, [textAt]);

  /** Finish the text being typed: kept as a stroke, unless it's blank. */
  function commitText() {
    const entry = textEntryRef.current;
    if (!entry) return;
    textEntryRef.current = null;
    setTextEntry(null);
    if (entry.value.trim()) {
      setStrokes((s) => [...s, { type: "text", color: entry.color, points: [{ x: entry.x, y: entry.y, width: entry.size }], text: entry.value }]);
    }
  }

  function cancelText() {
    textEntryRef.current = null;
    setTextEntry(null);
  }

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
  useLayoutEffect(redraw, [strokes, selected, size, markup, canvasWidth, canvasHeight, view.zoom]);

  /** Redraw the canvas whole, with the stroke being drawn too: a pinch can zoom mid-stroke, and a shape's drag moves
   * its end. A lasso being drawn shows as its outline, and deletes (or selects) once it's done. The selection shows
   * as its box, with its handles: turned with it while it's being turned. */
  function redraw() {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context || !size) return;
    context.resetTransform();
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.scale(canvas.width / size.width, canvas.height / size.height);
    const current = drawing.current?.stroke;
    drawStrokes(context, current ? [...strokes, current] : strokes);
    if (selecting.current) drawLassoOutline(context, selecting.current.points, view.zoom);
    const transform = transforming.current;
    if (transform?.handle === "rotate") drawSelection(context, transform.box, view.zoom, transform.angle);
    else if (selection.length) drawSelection(context, selectionBox(selection), view.zoom, 0);
  }

  /** Whether a pointer draws: in markup, a pen or the mouse with any tool but Move. Touch always pans. */
  const draws = (e: ReactPointerEvent) => editing && tool !== "pan" && (e.pointerType === "pen" || e.pointerType === "mouse");

  /** A pointer's position on the image, in its pixels. */
  function imagePoint(e: { clientX: number; clientY: number }): Point | null {
    const canvas = canvasRef.current;
    if (!canvas || !size) return null;
    const rect = canvas.getBoundingClientRect();
    return { x: ((e.clientX - rect.left) / rect.width) * size.width, y: ((e.clientY - rect.top) / rect.height) * size.height };
  }

  /** A stroke's width in image pixels: the line size on screen at the current zoom. A freehand stroke's thins from
   * it with the pen's pressure or the pointer's speed (see `drawFreehand`). */
  const lineWidth = lineSize / view.zoom;

  /** A freehand stroke's point at a pointer event: with its pressure, for a pen. */
  const freehandPoint = (point: Point, pointerType: string, pressure: number) =>
    pointerType === "pen" ? { ...point, width: lineWidth, pressure } : { ...point, width: lineWidth };

  /** Delete the strokes whose ink passes within the stroke eraser's reach of a point. */
  function eraseAt(point: Point, reach: number) {
    setStrokes((all) => {
      const kept = all.filter((s) => !touches(s, point, reach));
      return kept.length === all.length ? all : kept;
    });
  }

  function pointerDown(e: ReactPointerEvent) {
    if (e.button !== 0 && e.pointerType === "mouse") return;
    if (saving) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    if (draws(e)) {
      const point = imagePoint(e);
      if (!point || drawing.current || erasing.current || selecting.current || transforming.current || tool === "pan") return;
      if (tool === "erase") {
        // Deletes every stroke it touches, here and along its drag.
        const reach = Math.max(lineSize, ERASER_MIN_REACH) / view.zoom;
        erasing.current = { pointerId: e.pointerId, reach };
        eraseAt(point, reach);
        return;
      }
      if (tool === "lasso-erase") {
        // Deletes the strokes wholly inside the loop it draws, once it's done.
        selecting.current = { pointerId: e.pointerId, points: [point], erase: true };
        return;
      }
      if (tool === "select") {
        // On the selection, or a handle of it, transforms it; anywhere else drops it, and starts a lasso for another.
        const box = selection.length ? selectionBox(selection) : null;
        const handle = box && selectionHandle(box, point, view.zoom);
        if (box && handle) {
          transforming.current = { pointerId: e.pointerId, handle, from: point, box, originals: selection, current: selection, angle: 0 };
          return;
        }
        setSelected(new Set());
        setHover(null);
        selecting.current = { pointerId: e.pointerId, points: [point], erase: false };
        return;
      }
      if (tool === "comment") {
        // A click pins a comment, open to be written in; any other open one closes.
        commitText();
        const newId = typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2);
        const comment: Comment = { id: newId, x: point.x, y: point.y, text: "", isExpanded: true, page };
        setComments((all) => [
          ...all.filter((c) => !c.isExpanded || c.text.trim()).map((c) => ({ ...c, isExpanded: false })),
          comment,
        ]);
        return;
      }
      if (tool === "text") {
        // A click places a text, or, while one's being typed, just finishes it.
        if (textEntryRef.current) commitText();
        else setTextEntry({ ...point, size: textSize(lineSize) / view.zoom, color: ink, value: "" });
        return;
      }
      const stroke: Stroke = isShape(tool)
        ? { type: tool, color: ink, points: [{ ...point, width: lineWidth }] }
        : { type: tool, color: ink, points: [freehandPoint(point, e.pointerType, e.pressure)], taper: e.pointerType === "pen" ? "pen" : "speed" };
      drawing.current = { pointerId: e.pointerId, stroke };
      // A shape shows once it's dragged.
      if (!isShape(tool)) redraw();
      return;
    }
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
  }

  function pointerMove(e: ReactPointerEvent) {
    const current = drawing.current;
    if (current?.pointerId === e.pointerId) {
      const { stroke } = current;
      if (isShape(stroke.type)) {
        // A shape spans from where its drag started to where the pointer is.
        const point = imagePoint(e);
        if (!point) return;
        stroke.points[1] = { ...point, width: stroke.points[0].width };
        redraw();
        return;
      }
      // A pen reports more points than it fires events for; they're all kept, for a smooth line. Its outline is
      // worked out afresh from them all, so the canvas is redrawn.
      const events = e.nativeEvent.getCoalescedEvents?.() ?? [];
      for (const event of events.length ? events : [e.nativeEvent]) {
        const point = imagePoint(event);
        if (point) stroke.points.push(freehandPoint(point, e.pointerType, event.pressure));
      }
      redraw();
      return;
    }
    const eraser = erasing.current;
    if (eraser?.pointerId === e.pointerId) {
      const events = e.nativeEvent.getCoalescedEvents?.() ?? [];
      for (const event of events.length ? events : [e.nativeEvent]) {
        const point = imagePoint(event);
        if (point) eraseAt(point, eraser.reach);
      }
      return;
    }
    const transform = transforming.current;
    if (transform?.pointerId === e.pointerId) {
      // Transformed from the strokes as they were when the drag started, so its steps' rounding doesn't add up.
      const point = imagePoint(e);
      if (!point) return;
      const { strokes: next, angle } = transformStrokes(transform.originals, transform.box, transform.handle, transform.from, point);
      transform.angle = angle;
      replaceStrokes(new Map(transform.current.map((s, i) => [s, next[i]])));
      transform.current = next;
      return;
    }
    const lassoing = selecting.current;
    if (lassoing?.pointerId === e.pointerId) {
      const events = e.nativeEvent.getCoalescedEvents?.() ?? [];
      for (const event of events.length ? events : [e.nativeEvent]) {
        const point = imagePoint(event);
        if (point) lassoing.points.push(point);
      }
      redraw();
      return;
    }
    if (tool === "select" && draws(e) && !pointers.current.has(e.pointerId)) {
      // Hovering: the cursor shows what a drag from here would do.
      const point = imagePoint(e);
      setHover(point && selection.length ? selectionHandle(selectionBox(selection), point, view.zoom) : null);
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
    if (transforming.current?.pointerId === e.pointerId) {
      transforming.current = null;
      // A turned selection's box was drawn turned; it's redrawn upright, around where the strokes are now.
      setSelected((picked) => new Set(picked));
      return;
    }
    if (erasing.current?.pointerId === e.pointerId) {
      erasing.current = null;
      return;
    }
    const lassoing = selecting.current;
    if (lassoing?.pointerId === e.pointerId) {
      selecting.current = null;
      // A lasso picks (or the lasso eraser deletes) the strokes it wholly encloses; one that encloses nothing (a
      // click) just clears its outline.
      if (lassoing.points.length < 3) return redraw();
      const inside = new Set(strokes.filter((s) => lassoed(s, lassoing.points)));
      if (!lassoing.erase) setSelected(inside);
      else if (inside.size) setStrokes((all) => all.filter((s) => !inside.has(s)));
      else redraw();
      return;
    }
    const current = drawing.current;
    if (current?.pointerId !== e.pointerId) return;
    drawing.current = null;
    // A shape that was never dragged isn't one.
    if (isShape(current.stroke.type) && current.stroke.points.length < 2) return;
    setStrokes((s) => [...s, current.stroke]);
  }

  const heading = title || alt || name;
  const kind = isPdf ? "PDF" : "Image";
  const pageComments = comments.filter((c) => c.page === page);

  /** Change a comment, or, given null, remove it. */
  function updateComment(id: string, next: Partial<Comment> | null) {
    setComments((all) => (next ? all.map((c) => (c.id === id ? { ...c, ...next } : c)) : all.filter((c) => c.id !== id)));
  }

  return createPortal(
    <div role="dialog" aria-modal aria-label={heading || kind} className="fixed inset-0 z-50 flex flex-col bg-background/95">
      <header className="flex min-h-14 items-center justify-between gap-4 border-b border-border-default px-5 py-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-text-primary">{heading || kind}</p>
          <p className="truncate font-mono text-[13px] text-text-muted">
            {[
              pdf ? `Page ${page + 1} of ${pdf.numPages}` : size && `${size.width} × ${size.height}`,
              name !== heading && name,
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {canMarkup && !markup && (
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
          {TOOLS.map((t) =>
            !isEraser(t.tool) ? (
              <Segment key={t.tool} on={tool === t.tool} label={t.label} onClick={() => setTool(t.tool)}>
                <ToolIcon path={t.icon} dashed={t.dashed} />
              </Segment>
            ) : (
              // The erasers share a split button: the eraser last picked, and a menu to pick the other.
              t.tool === eraser && (
                <span key="eraser" ref={eraserMenuRef} className="relative flex items-center">
                  <Segment on={tool === t.tool} label={`${t.label} (or hold Shift)`} onClick={() => setTool(t.tool)}>
                    <ToolIcon path={t.icon} />
                  </Segment>
                  <button
                    type="button"
                    title="Choose the eraser"
                    aria-label="Choose the eraser"
                    aria-haspopup="menu"
                    aria-expanded={eraserMenu}
                    onClick={() => setEraserMenu((open) => !open)}
                    className="flex h-8 w-4 items-center justify-center rounded text-text-muted hover:bg-surface-raised hover:text-text-primary"
                  >
                    <svg aria-hidden width="8" height="8" viewBox="0 0 8 8" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M1.5 3l2.5 2.5L6.5 3" />
                    </svg>
                  </button>
                  {eraserMenu && (
                    <div role="menu" aria-label="Eraser" className="absolute left-0 top-full z-20 mt-1 min-w-[200px] rounded-lg border border-border-light bg-surface-raised py-1 shadow-xl">
                      {ERASERS.map((e) => (
                        <button
                          key={e.tool}
                          type="button"
                          role="menuitemradio"
                          aria-checked={eraser === e.tool}
                          onClick={() => {
                            setEraser(e.tool);
                            setTool(e.tool);
                            setEraserMenu(false);
                          }}
                          className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-[15px] hover:bg-surface-hover hover:text-text-primary focus:bg-surface-hover focus:outline-none ${
                            eraser === e.tool ? "text-accent-soft" : "text-text-secondary"
                          }`}
                        >
                          <ToolIcon path={e.icon} />
                          {e.name}
                        </button>
                      ))}
                    </div>
                  )}
                </span>
              )
            ),
          )}
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
                // Ink is for drawing: picking one recolours the selection, or else swaps Move, Select or an eraser
                // for the pen, but keeps a shape or text.
                if (tool === "select" && selection.length) {
                  replaceStrokes(new Map(selection.map((s) => [s, { ...s, color: c.value }])));
                } else if (tool === "pan" || tool === "select" || isEraser(tool)) setTool("draw");
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
          <Segment
            on={false}
            label={pdf ? "Clear this page's markup and comments" : "Clear the markup and comments"}
            disabled={(!strokes.length && !pageComments.length) || saving}
            onClick={() => {
              setStrokes([]);
              setComments((all) => all.filter((c) => c.page !== page));
            }}
          >
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
      {error && <p className="px-5 pt-2 text-[15px] text-accent">{error}</p>}
      <div
        ref={stageRef}
        className={`relative flex-1 touch-none select-none overflow-hidden ${
          editing && tool === "text"
            ? "cursor-text"
            : editing && tool === "select" && hover
              ? HANDLE_CURSORS[hover]
              : editing && tool !== "pan" ? "cursor-crosshair" : "cursor-grab active:cursor-grabbing"
        }`}
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
          {isPdf ? (
            <canvas ref={pdfCanvasRef} aria-label={heading || kind} className="block h-full w-full bg-white shadow-lg" />
          ) : (
            <img
              src={src}
              alt={alt ?? ""}
              draggable={false}
              onLoad={(e) => {
                const { naturalWidth: width, naturalHeight: height } = e.currentTarget;
                setView({ zoom: fitZoom(width, height), x: 0, y: 0 });
                setSize({ width, height });
              }}
              className="block h-full w-full max-w-none shadow-lg"
            />
          )}
          {/* The markup shows over the file whether or not it's being edited. */}
          {size && <canvas ref={canvasRef} width={canvasWidth} height={canvasHeight} className="absolute inset-0 h-full w-full" />}
          {editing && textEntry && (
            // In image pixels, like the canvas, so it zooms with the image and its text sits where it's drawn.
            <input
              ref={textInputRef}
              aria-label="Text"
              value={textEntry.value}
              onChange={(e) => setTextEntry({ ...textEntry, value: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  commitText();
                }
              }}
              onBlur={commitText}
              // Typing and selecting in it isn't drawing on the stage.
              onPointerDown={(e) => e.stopPropagation()}
              className="absolute m-0 select-text border-0 bg-transparent p-0"
              style={{
                left: textEntry.x,
                top: textEntry.y,
                font: textFont(textEntry.size),
                lineHeight: 1,
                color: textEntry.color,
                width: textWidth(textEntry.value, textEntry.size) + textEntry.size,
                outline: `${1.5 / view.zoom}px dashed currentColor`,
                outlineOffset: 2 / view.zoom,
              }}
            />
          )}
          {size &&
            pageComments.map((c) => (
              <CommentPin
                key={c.id}
                comment={c}
                zoom={view.zoom}
                editable={editing}
                onToggle={() =>
                  c.isExpanded && !c.text.trim() ? updateComment(c.id, null) : updateComment(c.id, { isExpanded: !c.isExpanded })
                }
                onSave={(text) => updateComment(c.id, text.trim() ? { text, isExpanded: false } : null)}
                onDelete={() => updateComment(c.id, null)}
              />
            ))}
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
        {pdf && pdf.numPages > 1 && (
          <>
            <span aria-hidden className="mx-1 h-5 w-px bg-border-default" />
            <Segment on={false} label="Previous page" disabled={page === 0 || saving} onClick={() => goToPage(page - 1)}>
              ‹
            </Segment>
            <span role="status" aria-label="Page" className="w-16 text-center font-mono text-xs text-text-secondary">
              {page + 1} / {pdf.numPages}
            </span>
            <Segment on={false} label="Next page" disabled={page === pdf.numPages - 1 || saving} onClick={() => goToPage(page + 1)}>
              ›
            </Segment>
          </>
        )}
      </footer>
    </div>,
    document.body,
  );
}

const midpoint = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

/** The erasers, which share a split button in the toolbar, with their icons (paths in a 16 × 16 box). */
const ERASERS: { tool: Eraser; name: string; label: string; icon: string }[] = [
  {
    tool: "lasso-erase",
    name: "Lasso eraser",
    label: "Lasso eraser: loop around ink to delete it",
    // A lasso's loop, its rope running down to an eraser's block.
    icon: "M7 2c2.8 0 5 1.3 5 3s-2.2 3-5 3-5-1.3-5-3 2.2-3 5-3z M5.4 7.8c-.6 1.2-.2 2.6 1.2 3.2.9.4 1.9.7 2.7 1.5 M8.6 13.2l3.6-3.6a.7.7 0 0 1 1 0l1.2 1.2a.7.7 0 0 1 0 1L12 14.2H9.6z M10.4 11.4l2.2 2.2",
  },
  {
    tool: "erase",
    name: "Stroke eraser",
    label: "Stroke eraser: a stylus or the mouse deletes the ink it touches",
    icon: "M6 13.5h7.5 M2.8 9.7l6.5-6.5a1 1 0 0 1 1.4 0l2.6 2.6a1 1 0 0 1 0 1.4L7.6 13H5.1z M6 6.5l4 4",
  },
];

/** A speech bubble, in a 16 × 16 box. */
const COMMENT_ICON = "M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z";

/** The markup tools, with their icons (paths in a 16 × 16 box, dashed for some). */
const TOOLS: { tool: Tool; label: string; icon: string; dashed?: boolean }[] = [
  { tool: "draw", label: "Pen: a stylus or the mouse draws", icon: "M10.5 2.5l3 3-8 8H2.5v-3z M8.5 4.5l3 3" },
  ...ERASERS,
  {
    tool: "select",
    label: "Select: loop around ink, then drag it to move it, its corners to scale it or its top handle to turn it (Delete removes it)",
    icon: "M8 2.5c3.3 0 5.5 1.6 5.5 3.6S11.3 9.7 8 9.7 2.5 8.1 2.5 6.1 4.7 2.5 8 2.5z M5.2 9.2c-.9.9-.8 2.4.3 3 .9.5 1.4 1 1.2 2.3",
    dashed: true,
  },
  { tool: "line", label: "Line: drag to draw one", icon: "M3 13L13 3" },
  { tool: "arrow", label: "Arrow: drag from its tail to its head", icon: "M3 13L13 3 M7 3h6v6" },
  { tool: "rect", label: "Rectangle: drag across its corners", icon: "M2.5 4h11v8h-11z" },
  { tool: "circle", label: "Ellipse: drag across its bounds", icon: "M14 8a6 4.5 0 1 1-12 0a6 4.5 0 1 1 12 0z" },
  { tool: "text", label: "Text: click to type some", icon: "M3 4.5V3h10v1.5 M8 3v10 M6 13h4" },
  { tool: "comment", label: "Comment: click to pin a sticky note there", icon: COMMENT_ICON },
  { tool: "pan", label: "Move: a stylus or the mouse pans", icon: "M8 1.5v13 M1.5 8h13 M6 3.5l2-2 2 2 M6 12.5l2 2 2-2 M3.5 6l-2 2 2 2 M12.5 6l2 2-2 2" },
];

/** Draw whole strokes, in image pixels. */
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
function drawLassoOutline(context: CanvasRenderingContext2D, points: Point[], zoom: number) {
  traceLasso(context, points);
  strokeDashed(context, zoom);
}

/** Draw the selection's box, its corners' handles to scale it and the handle above it to turn it, turned by `angle`
 * about its center, at `zoom`. */
function drawSelection(context: CanvasRenderingContext2D, box: Box, zoom: number, angle: number) {
  const center = boxCenter(box);
  const rotateAt = rotateHandle(box, zoom);
  const size = HANDLE_SIZE / zoom;
  context.save();
  context.translate(center.x, center.y);
  context.rotate(angle);
  context.translate(-center.x, -center.y);
  context.beginPath();
  context.rect(box.left, box.top, box.right - box.left, box.bottom - box.top);
  context.moveTo(center.x, box.top);
  context.lineTo(rotateAt.x, rotateAt.y);
  strokeDashed(context, zoom);
  context.lineWidth = 1.5 / zoom;
  context.fillStyle = "#ffffff";
  context.strokeStyle = "#111111";
  context.beginPath();
  for (const { x, y } of Object.values(boxCorners(box))) context.rect(x - size / 2, y - size / 2, size, size);
  context.moveTo(rotateAt.x + size / 2, rotateAt.y);
  context.arc(rotateAt.x, rotateAt.y, size / 2, 0, Math.PI * 2);
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
function textWidth(text: string, size: number): number {
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

/** The points that outline a stroke, in image pixels: a freehand one's own, a shape's corners (or, for an ellipse,
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
function lassoed(stroke: Stroke, loop: Point[]): boolean {
  return outline(stroke, 48).every((p) => insideLoop(p, loop));
}

/** The least the stroke eraser reaches from the pointer, in screen pixels, so the thinnest line size still hits ink. */
const ERASER_MIN_REACH = 6;

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
function touches(stroke: Stroke, point: Point, reach: number): boolean {
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
function selectionBox(strokes: Stroke[]): Box {
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

const boxCenter = (box: Box): Point => ({ x: (box.left + box.right) / 2, y: (box.top + box.bottom) / 2 });
const boxCorners = (box: Box): Record<Corner, Point> => ({
  nw: { x: box.left, y: box.top },
  ne: { x: box.right, y: box.top },
  se: { x: box.right, y: box.bottom },
  sw: { x: box.left, y: box.bottom },
});
const OPPOSITE: Record<Corner, Corner> = { nw: "se", ne: "sw", se: "nw", sw: "ne" };
/** Where the handle that turns the selection is: above its box's middle, at `zoom`. */
const rotateHandle = (box: Box, zoom: number): Point => ({ x: (box.left + box.right) / 2, y: box.top - ROTATE_OFFSET / zoom });

/** The selection's handle at a point, at `zoom`: the rotate handle, a corner, or its box, to move it; or none. */
function selectionHandle(box: Box, point: Point, zoom: number): Handle | null {
  const reach = HANDLE_SIZE / zoom;
  if (distance(point, rotateHandle(box, zoom)) <= reach) return "rotate";
  for (const [corner, at] of Object.entries(boxCorners(box)) as [Corner, Point][]) {
    if (distance(point, at) <= reach) return corner;
  }
  const inside = point.x >= box.left && point.x <= box.right && point.y >= box.top && point.y <= box.bottom;
  return inside ? "move" : null;
}

/** A stroke with each point mapped by `map` and its width scaled by `scale`, and, if it's a text, turned by `angle`. */
function mapStroke(stroke: Stroke, map: (p: Point) => Point, scale = 1, angle = 0): Stroke {
  const points = stroke.points.map((p) => ({ ...map(p), width: p.width * scale }));
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
function transformStrokes(strokes: Stroke[], box: Box, handle: Handle, from: Point, to: Point): { strokes: Stroke[]; angle: number } {
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
  const corners = boxCorners(box);
  const anchor = corners[OPPOSITE[handle]];
  // The dragged corner follows the pointer; the scale is how far along the box's diagonal it's gone.
  const diagonal = { x: corners[handle].x - anchor.x, y: corners[handle].y - anchor.y };
  const length = diagonal.x ** 2 + diagonal.y ** 2;
  if (!length) return { strokes, angle: 0 };
  const dragged = { x: corners[handle].x + to.x - from.x - anchor.x, y: corners[handle].y + to.y - from.y - anchor.y };
  const scale = Math.max(MIN_SCALE, (dragged.x * diagonal.x + dragged.y * diagonal.y) / length);
  const grow = (p: Point) => ({ x: anchor.x + (p.x - anchor.x) * scale, y: anchor.y + (p.y - anchor.y) * scale });
  return { strokes: strokes.map((s) => mapStroke(s, grow, scale)), angle: 0 };
}

/** Whether a key's going to a field being typed in. */
export const isTyping = (target: EventTarget | null) =>
  target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));

/** A tool's icon: a path in a 16 × 16 box, maybe dashed. */
function ToolIcon({ path, dashed }: { path: string; dashed?: boolean }) {
  return (
    <svg aria-hidden width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d={path} strokeDasharray={dashed ? "2 2.5" : undefined} />
    </svg>
  );
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
      className={`flex h-8 min-w-8 items-center justify-center rounded px-2 text-[15px] disabled:cursor-not-allowed disabled:opacity-40 ${
        on ? "bg-accent/[0.16] text-accent-soft" : "text-text-secondary hover:bg-surface-raised hover:text-text-primary"
      }`}
    >
      {children}
    </button>
  );
}

/**
 * A comment, pinned where it was placed: in image pixels, like the canvas, so it stays on its spot as the view pans
 * and zooms, but scaled back to stay the same size on screen. Collapsed, it's an icon, which a click opens to a
 * sticky note: written in and saved (which collapses it again) while `editable`, else just read.
 */
export function CommentPin({
  comment,
  zoom,
  editable,
  onToggle,
  onSave,
  onDelete,
}: {
  comment: Comment;
  zoom: number;
  editable: boolean;
  onToggle: () => void;
  onSave: (text: string) => void;
  onDelete: () => void;
}) {
  const [draft, setDraft] = useState(comment.text);
  const fieldRef = useRef<HTMLTextAreaElement>(null);

  // Opening it starts from what's saved, in the field, once the click that opened it is done.
  useEffect(() => {
    if (!comment.isExpanded) return;
    setDraft(comment.text);
    const timer = setTimeout(() => fieldRef.current?.focus());
    return () => clearTimeout(timer);
  }, [comment.isExpanded]);

  return (
    <div
      className="absolute"
      style={{ left: comment.x, top: comment.y, transform: `scale(${1 / zoom})`, transformOrigin: "0 0" }}
      // Clicking and typing in it isn't drawing on, or panning, the stage.
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        title={comment.text || "Comment"}
        aria-label={comment.isExpanded ? "Close the comment" : "Open the comment"}
        aria-expanded={comment.isExpanded}
        onClick={onToggle}
        className={`absolute flex h-7 w-7 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border-2 border-white shadow-lg ${
          comment.isExpanded ? "bg-accent text-white" : "bg-yellow-300 text-neutral-900 hover:scale-110"
        }`}
      >
        <svg aria-hidden width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round">
          <path d={COMMENT_ICON} />
        </svg>
      </button>
      {comment.isExpanded && (
        <div role="note" className="absolute left-5 top-2 w-64 cursor-auto rounded-md bg-yellow-100 p-2 text-neutral-900 shadow-xl">
          {editable ? (
            <>
              <textarea
                ref={fieldRef}
                aria-label="Comment"
                value={draft}
                rows={4}
                placeholder="Write a comment…"
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                    e.preventDefault();
                    onSave(draft);
                  }
                }}
                className="block w-full resize-none select-text rounded border border-yellow-300 bg-yellow-50 p-1.5 text-sm text-neutral-900 placeholder:text-neutral-500 focus:outline-none"
              />
              <div className="mt-2 flex items-center justify-end gap-2">
                {comment.text && (
                  <button type="button" onClick={onDelete} className="mr-auto rounded px-2 py-1 text-xs font-medium text-neutral-600 hover:bg-yellow-200">
                    Delete
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => onSave(draft)}
                  title="Save (Ctrl+Enter)"
                  className="rounded bg-neutral-900 px-3 py-1 text-xs font-medium text-yellow-50 hover:bg-neutral-700"
                >
                  Save
                </button>
              </div>
            </>
          ) : (
            <p className="max-h-60 select-text overflow-auto whitespace-pre-wrap text-sm">{comment.text}</p>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * A stored image's markup, shown over it where it sits in a note: its strokes on a canvas, and its comments' pins,
 * which open to be read. Laid over the top of the image's (positioned) box at its width, scaled down from the image's
 * pixels; it doesn't take the pointer, but its pins do. Loaded again whenever `version` changes, as it does once the
 * lightbox, which may have changed it, closes.
 */
export function MarkupOverlay({ src, version = 0 }: { src: string; version?: number }) {
  const boxRef = useRef<HTMLSpanElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const markupUrl = markupUrlOf(src);
  // The image's strokes and comments (its page 0's), its size in its pixels, and its width on screen.
  const [markup, setMarkup] = useState<{ strokes: Stroke[]; comments: Comment[] } | null>(null);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const [shown, setShown] = useState(0);
  // The comment opened to be read.
  const [open, setOpen] = useState<string | null>(null);
  const empty = !markup || (!markup.strokes.length && !markup.comments.length);

  useEffect(() => {
    if (!markupUrl) return;
    const controller = new AbortController();
    getJson<MediaMarkup>(markupUrl, controller.signal).then(
      (sidecar) =>
        setMarkup({ strokes: strokesByPage(sidecar).get(0) ?? [], comments: sidecar.comments.filter((c) => (c.page ?? 0) === 0) }),
      // The note still shows the image without it.
      () => !controller.signal.aborted && setMarkup(null),
    );
    return () => controller.abort();
  }, [markupUrl, version]);

  // The image's own size, which the markup's pixels are in: only wanted once there's markup to show.
  useEffect(() => {
    if (empty || size) return;
    let cancelled = false;
    const image = new Image();
    image.onload = () => !cancelled && setSize({ width: image.naturalWidth, height: image.naturalHeight });
    image.src = src;
    return () => {
      cancelled = true;
    };
  }, [src, empty, size]);

  // Its width on screen follows the image's (a resize, a narrower window).
  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const observer = new ResizeObserver(() => setShown(box.clientWidth));
    observer.observe(box);
    setShown(box.clientWidth);
    return () => observer.disconnect();
  }, [empty, size]);

  const scale = size && shown ? shown / size.width : 0;

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context || !size || !scale || !markup) return;
    const pixels = Math.min(window.devicePixelRatio * scale, MAX_CANVAS_SIDE / Math.max(size.width, size.height));
    canvas.width = Math.max(1, Math.round(size.width * pixels));
    canvas.height = Math.max(1, Math.round(size.height * pixels));
    context.resetTransform();
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.scale(canvas.width / size.width, canvas.height / size.height);
    drawStrokes(context, markup.strokes);
  }, [markup, size, scale]);

  if (!markupUrl || empty || !size || !markup) return null;
  return (
    <span
      ref={boxRef}
      aria-hidden={!markup.comments.length}
      className="pointer-events-none absolute left-0 top-0 z-[1] block w-full"
      style={{ aspectRatio: `${size.width} / ${size.height}` }}
    >
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />
      {scale > 0 && (
        <span className="absolute left-0 top-0 block" style={{ width: size.width, height: size.height, transform: `scale(${scale})`, transformOrigin: "0 0" }}>
          {markup.comments.map((c) => (
            <span key={c.id} className="pointer-events-auto">
              <CommentPin
                comment={{ ...c, isExpanded: open === c.id }}
                zoom={scale}
                editable={false}
                onToggle={() => setOpen((id) => (id === c.id ? null : c.id))}
                onSave={() => setOpen(null)}
                onDelete={() => setOpen(null)}
              />
            </span>
          ))}
        </span>
      )}
    </span>
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
      className="absolute right-2 top-2 z-[2] flex h-8 w-8 print:hidden items-center justify-center rounded-md border border-border-strong bg-background/80 text-text-primary opacity-0 transition-opacity duration-150 hover:bg-surface-raised focus:opacity-100 group-hover:opacity-100"
    >
      <svg aria-hidden width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
        <path d="M8.5 1.5h4v4M12.5 1.5 8 6M5.5 12.5h-4v-4M1.5 12.5 6 8" />
      </svg>
    </button>
  );
}
