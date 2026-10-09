import type { PDFDocumentLoadingTask, PDFDocumentProxy, RenderTask } from "pdfjs-dist";
import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";

import { getJson, message, sendJson } from "../lib/api";
import {
  distance,
  drawLassoOutline,
  drawSelection,
  drawStrokes,
  ERASER_MIN_REACH,
  HANDLE_CURSORS,
  INKS,
  isEraser,
  isShape,
  isTyping,
  lassoed,
  loadPdf,
  MAX_CANVAS_AREA,
  MAX_CANVAS_SIDE,
  midpoint,
  newId,
  PDF_RENDER_DELAY,
  PDF_SCALE,
  selectionBox,
  selectionHandle,
  SIZES,
  strokesByPage,
  textFont,
  textSize,
  textWidth,
  touches,
  transformStrokes,
  type Comment,
  type Eraser,
  type Handle,
  type MediaMarkup,
  type Point,
  type Stroke,
  type TextEntry,
  type Tool,
  type Transform,
} from "./markupCore";
import { CommentPin, MarkupTools, Segment, ToolbarDivider } from "./markupUi";

// The markup engine lives in markupCore (shared with the whiteboard); these are re-exported for the notes' views.
export type { MediaMarkup } from "./markupCore";
export { drawStrokes, isTyping, strokesByPage } from "./markupCore";
export { CommentPin } from "./markupUi";

/** The view: the image's scale (1 is its natural size) and its center's offset from the stage's, in screen pixels. */
type View = { zoom: number; x: number; y: number };

const MIN_ZOOM = 0.05;
const MAX_ZOOM = 8;
const ZOOM_STEP = 1.25;
const clampZoom = (zoom: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));

/** Whether a URL is a PDF's, by its name. */
export const isPdfUrl = (url: string) => /\.pdf$/i.test(new URL(url, window.location.href).pathname);

/** A stored file's markup sidecar's URL (in the same space), or null for a file that isn't stored in one. */
export function markupUrlOf(src: string): string | null {
  const url = new URL(src, window.location.href);
  if (url.origin !== window.location.origin || !/^\/api\/notes\/image\/[^/]+$/.test(url.pathname)) return null;
  return `${url.pathname}/markup${url.search}`;
}

/** The sidecar holding strokes kept by page (the image's are page 0's) and comments; a comment's open state isn't
 * kept, so opening one doesn't count as a change. */
function snapshot(byPage: Map<number, Stroke[]>, comments: Comment[]): MediaMarkup {
  return {
    strokes: [...byPage].sort(([a], [b]) => a - b).flatMap(([page, list]) => list.map((s) => ({ ...s, page }))),
    comments: comments.map((c) => ({ ...c, isExpanded: false })),
  };
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
  // The eraser the toolbar's eraser button (and a right click) picks, and whether its menu, to pick the other, is open.
  const [eraser, setEraser] = useState<Eraser>("lasso-erase");
  const eraserRef = useRef(eraser);
  eraserRef.current = eraser;
  const [eraserMenu, setEraserMenu] = useState(false);
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
  // The tool a right click swapped for the eraser, for the next to swap back to.
  const previousToolRef = useRef<Tool | null>(null);
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

  /** Start an eraser's drag at `point`. */
  function eraseDown(eraser: Eraser, point: Point, pointerId: number) {
    if (eraser === "erase") {
      // Deletes every stroke it touches, here and along its drag.
      const reach = Math.max(lineSize, ERASER_MIN_REACH) / view.zoom;
      erasing.current = { pointerId, reach };
      eraseAt(point, reach);
    } else {
      // Deletes the strokes wholly inside the loop it draws, once it's done.
      selecting.current = { pointerId, points: [point], erase: true };
    }
  }

  /** A right click swaps the tool for the eraser, which its drag then erases with, or the eraser back for the tool. */
  function rightDown(e: ReactPointerEvent) {
    e.preventDefault();
    if (!editing || drawing.current || erasing.current || selecting.current || transforming.current) return;
    commitText();
    if (isEraser(tool)) {
      setTool(previousToolRef.current ?? "draw");
      previousToolRef.current = null;
      return;
    }
    previousToolRef.current = tool;
    const eraser = eraserRef.current;
    setTool(eraser);
    setEraserMenu(false);
    const point = imagePoint(e);
    if (point) eraseDown(eraser, point, e.pointerId);
  }

  function pointerDown(e: ReactPointerEvent) {
    const right = e.pointerType === "mouse" && e.button === 2;
    if (e.button !== 0 && e.pointerType === "mouse" && !right) return;
    if (saving) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    if (right) return rightDown(e);
    if (draws(e)) {
      const point = imagePoint(e);
      if (!point || drawing.current || erasing.current || selecting.current || transforming.current || tool === "pan") return;
      if (isEraser(tool)) return eraseDown(tool, point, e.pointerId);
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
        const comment: Comment = { id: newId(), x: point.x, y: point.y, text: "", isExpanded: true, page };
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
          <MarkupTools
            tool={tool}
            onTool={setTool}
            eraser={eraser}
            onEraser={setEraser}
            eraserMenu={eraserMenu}
            onEraserMenu={setEraserMenu}
            ink={ink}
            onInk={(value) => {
              setInk(value);
              // Ink is for drawing: picking one recolours the selection, or else swaps Move, Select or an eraser
              // for the pen, but keeps a shape or text.
              if (tool === "select" && selection.length) {
                replaceStrokes(new Map(selection.map((s) => [s, { ...s, color: value }])));
              } else if (tool === "pan" || tool === "select" || isEraser(tool)) setTool("draw");
            }}
            lineSize={lineSize}
            onLineSize={setLineSize}
          />
          <ToolbarDivider />
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
        // A right click swaps to the eraser and back (see rightDown), so it doesn't open the browser's menu.
        onContextMenu={(e) => e.preventDefault()}
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
        <ToolbarDivider />
        <Segment on={false} label="Fit to the screen" onClick={fit}>
          Fit
        </Segment>
        <Segment on={false} label="Actual size" onClick={() => zoomTo(1)}>
          100%
        </Segment>
        {pdf && pdf.numPages > 1 && (
          <>
            <ToolbarDivider />
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
