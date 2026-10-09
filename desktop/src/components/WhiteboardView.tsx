import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";

import { message, uploadFile } from "../lib/api";
import MediaLightbox from "./MediaLightbox";
import Popover from "./Popover";
import {
  boxCenter,
  distance,
  drawLassoOutline,
  drawSelection,
  drawStrokes,
  ERASER_MIN_REACH,
  frameBounds,
  frameCenter,
  HANDLE_CURSORS,
  INKS,
  insideLoop,
  isEraser,
  isShape,
  isTyping,
  lassoed,
  MAX_CANVAS_AREA,
  midpoint,
  newId,
  PDF_RENDER_DELAY,
  PDF_SCALE,
  selectionBox,
  selectionExtent,
  selectionFrame,
  selectionHandle,
  SIZES,
  textFont,
  textSize,
  textWidth,
  touches,
  transformGroup,
  turnAbout,
  type Box,
  type Comment,
  type Eraser,
  type Handle,
  type Point,
  type Stroke,
  type TextEntry,
  type Tool,
  type Transform,
} from "./markupCore";
import { CommentPin, MarkupTools, Segment, ToolbarDivider, ToolIcon } from "./markupUi";
import {
  acquirePdf,
  normalizeZ,
  parseWhiteboard,
  restack,
  serializeWhiteboard,
  type FloatingElement,
  type LockedLayer,
  type WhiteboardDoc,
} from "./whiteboard";

/** The view: screen pixels per world unit, and where the world's origin is on the stage, from its top left. */
type View = { zoom: number; x: number; y: number };
/** A drag transforming the selection, its strokes and floating elements together: as well as the strokes', the
 * elements as they were when it started, how far the box they were in was turned, the least it may scale them by (so
 * none gets too small to grab), and whether it's moved yet (a click doesn't). */
type GroupTransform = Transform & { boxAngle: number; elements: FloatingElement[]; min: number; moved: boolean };

const MIN_ZOOM = 0.05;
const MAX_ZOOM = 8;
const ZOOM_STEP = 1.25;
const clampZoom = (zoom: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
/** The blueprint grid's cell, in world units, and how many cells a major line spans. */
const GRID = 20;
const GRID_MAJOR = 5;
/** The least a grid cell is on screen, in pixels, before the grid coarsens by `GRID_MAJOR`. */
const GRID_MIN_CELL = 10;
/** How many steps back Undo goes. */
const HISTORY_LIMIT = 100;

/** How far a drag goes, in screen pixels, before it moves anything: a click on the selection shouldn't nudge it. */
const DRAG_THRESHOLD = 3;
/** The least a floating element's shorter side is scaled down to (unless it's already smaller), in screen pixels at the zoom it's resized at. */
const MIN_ELEMENT_SIDE = 24;
/** A pinned PDF page's render's longest side, in device pixels. */
const MAX_PDF_SIDE = 4096;
/** How much of the visible stage a newly inserted file may take up. */
const INSERT_FIT = 0.6;
/** The room left around the content when fitting the view to it, in screen pixels. */
const FIT_PADDING = 48;

/** The tools' keys (E picks the eraser last used). */
const SHORTCUTS: Record<string, Tool> = { v: "select", p: "draw", e: "lasso-erase", r: "rect", o: "circle", l: "line", a: "arrow", t: "text", c: "comment", h: "pan" };

/** A world point in a floating element's own frame (turned back about its center), to test against its upright box. */
const toElementFrame = (e: FloatingElement, point: Point): Point => turnAbout(point, frameCenter(e), -(e.angle ?? 0));

/** A world point in the selection's frame (turned back about its box's center), to test against its handles. */
const toSelectionFrame = (frame: { box: Box; angle: number }, point: Point): Point => turnAbout(point, boxCenter(frame.box), -frame.angle);
const isPdfFile = (file: File) => file.type === "application/pdf" || /\.pdf$/i.test(file.name);
const isImageFile = (file: File) => file.type.startsWith("image/");

/** The box around everything on a board, locked or not, or null for an empty one. */
function contentBounds(doc: WhiteboardDoc): Box | null {
  const layers = doc.lockedLayers ?? [];
  const elements = [...layers.flatMap((l) => l.elements), ...doc.elements];
  const strokes = [...layers.flatMap((l) => l.strokes), ...doc.strokes];
  const boxes: Box[] = [
    ...elements.map(frameBounds),
    ...(strokes.length ? [selectionBox(strokes)] : []),
    ...doc.comments.map((c) => ({ left: c.x, top: c.y, right: c.x, bottom: c.y })),
  ];
  if (!boxes.length) return null;
  return boxes.reduce((a, b) => ({
    left: Math.min(a.left, b.left),
    top: Math.min(a.top, b.top),
    right: Math.max(a.right, b.right),
    bottom: Math.max(a.bottom, b.bottom),
  }));
}

/**
 * An infinite whiteboard: floating images and PDF pages, stacked by their `z`, with the lightbox's markup (pen,
 * shapes, text, comments, select and the erasers) drawn over them, on a dark stage with an optional blueprint grid.
 * Dragging (with the Move tool, Space held, the middle button or a finger) pans it; Ctrl/Cmd+wheel or a pinch zooms,
 * and, with `captureWheel`, the wheel pans (else it scrolls the page, as a widget in a note should).
 *
 * Its state is the JSON `value` (see whiteboard.ts); while `editable`, each finished edit hands the new JSON to
 * `onChange`. A `value` that changes from outside (anything but the last JSON handed out) is loaded afresh. With a
 * `spaceId`, images and PDFs can be inserted (the toolbar's button, a drop or a paste): they're uploaded to the space.
 *
 * With the Select tool, a click picks a stroke or a floating element, and a loop picks the strokes and elements it
 * goes round: whatever's picked is dragged, turned and scaled from its corners together. Picked elements can be
 * restacked or deleted from the mini-toolbar over them, and one alone opened or, for a PDF, turned to another page.
 * Ctrl/Cmd+Z and Ctrl/Cmd+Shift+Z undo and redo.
 *
 * The selection can be locked into the background as a layer: drawn behind everything else and out of the tools'
 * reach (they only see the board's own strokes and elements) till it's unlocked from the toolbar's Locked layers menu.
 */
export default function WhiteboardView({
  value,
  onChange,
  editable,
  spaceId,
  captureWheel = false,
  onEscape,
  onSave,
  toolbarEnd,
  autoFocus = false,
  className = "",
}: {
  value: string;
  onChange?: (json: string) => void;
  editable: boolean;
  spaceId?: number;
  captureWheel?: boolean;
  /** Escape with nothing else to close or drop (no text being typed, no selection). */
  onEscape?: () => void;
  /** Ctrl/Cmd+S. */
  onSave?: () => void;
  /** Shown at the end of the toolbar (or, read-only, over the stage's top right). */
  toolbarEnd?: ReactNode;
  /** Take the focus when it's shown, so its keys work straight away. */
  autoFocus?: boolean;
  className?: string;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textInputRef = useRef<HTMLInputElement>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  // The board, as it's edited; the board as last committed (each finished edit is), as JSON too, and the boards
  // Undo and Redo go back and forward to.
  const [initial] = useState(() => {
    const doc = parseWhiteboard(value);
    return { doc, json: serializeWhiteboard(doc) };
  });
  const [doc, setDoc] = useState<WhiteboardDoc>(initial.doc);
  const committed = useRef(initial.doc);
  const lastEmitted = useRef(initial.json);
  const lastValue = useRef(value);
  // The board a reload from outside replaced, which isn't committed even if it changed in the same render.
  const discarded = useRef<WhiteboardDoc | null>(null);
  const undoStack = useRef<WhiteboardDoc[]>([]);
  const redoStack = useRef<WhiteboardDoc[]>([]);
  // Bumped as the history changes, so Undo and Redo's buttons follow it.
  const [, setHistoryVersion] = useState(0);
  // A drag that changes the board as it goes (moving, scaling, erasing): committed once, when it ends.
  const [busy, setBusy] = useState(false);

  const [stageSize, setStageSize] = useState({ width: 0, height: 0 });
  const stageSizeRef = useRef(stageSize);
  stageSizeRef.current = stageSize;
  const fitted = useRef(false);
  const [view, setView] = useState<View>({ zoom: 1, x: 0, y: 0 });
  const viewRef = useRef(view);
  viewRef.current = view;
  const captureWheelRef = useRef(captureWheel);
  captureWheelRef.current = captureWheel;

  const [tool, setTool] = useState<Tool>(editable ? "draw" : "pan");
  const toolRef = useRef(tool);
  toolRef.current = tool;
  const [eraser, setEraser] = useState<Eraser>("lasso-erase");
  const eraserRef = useRef(eraser);
  eraserRef.current = eraser;
  const [eraserMenu, setEraserMenu] = useState(false);
  // White, which shows on the dark stage.
  const [ink, setInk] = useState(INKS.find((i) => i.name === "White")?.value ?? INKS[5].value);
  const [lineSize, setLineSize] = useState(SIZES[1]);
  // Space held pans, whatever the tool; the tool Shift swapped for the eraser, while it's held.
  const [spaceHeld, setSpaceHeld] = useState(false);
  const shiftFrom = useRef<Tool | null>(null);
  const activeTool: Tool = !editable || spaceHeld ? "pan" : tool;

  // The strokes and the floating elements (by id) picked, those of them still on the board, and the box their
  // handles go round.
  const [selected, setSelected] = useState<Set<Stroke>>(() => new Set());
  const selection = doc.strokes.filter((s) => selected.has(s));
  const [selectedElements, setSelectedElements] = useState<Set<string>>(() => new Set());
  const pickedElements = doc.elements.filter((e) => selectedElements.has(e.id));
  const frame = selectionFrame(selection, pickedElements);
  // The cursor over the selection's handles.
  const [hover, setHover] = useState<string | null>(null);

  // Pointers down panning (one) or pinching (two), where they last were; the stroke being drawn; the stroke
  // eraser's drag; the lasso being drawn; and the drag transforming what's picked.
  const pointers = useRef(new Map<number, Point>());
  const [panning, setPanning] = useState(false);
  const drawing = useRef<{ pointerId: number; stroke: Stroke } | null>(null);
  const erasing = useRef<{ pointerId: number; reach: number } | null>(null);
  const selecting = useRef<{ pointerId: number; points: Point[]; erase: boolean } | null>(null);
  const transforming = useRef<GroupTransform | null>(null);

  const [textEntry, setTextEntry] = useState<TextEntry | null>(null);
  const textEntryRef = useRef(textEntry);
  textEntryRef.current = textEntry;
  // The comment opened, and a new one being written (only added to the board once it's saved with some text).
  const [expanded, setExpanded] = useState<string | null>(null);
  const [newComment, setNewComment] = useState<Comment | null>(null);

  const [uploads, setUploads] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [dropping, setDropping] = useState(false);
  // The floating element opened in the lightbox.
  const [opened, setOpened] = useState<FloatingElement | null>(null);
  // The Locked layers menu, and the button it hangs from.
  const [layersMenu, setLayersMenu] = useState(false);
  const layersButtonRef = useRef<HTMLSpanElement>(null);
  const lockedLayers = doc.lockedLayers ?? [];

  const canInsert = editable && spaceId !== undefined;
  const isEmpty = !doc.elements.length && !doc.strokes.length && !doc.comments.length && !lockedLayers.length;

  // ---- The board's state and history ----

  // A board changed from outside (another copy saved, the note reloaded, the editor's own Undo) is loaded afresh.
  // Before the commit below, so JSON handed out a render ago and only now handed back isn't taken for a change.
  useEffect(() => {
    if (value === lastValue.current) return;
    lastValue.current = value;
    if (value === lastEmitted.current) return;
    const next = parseWhiteboard(value);
    discarded.current = doc;
    committed.current = next;
    lastEmitted.current = serializeWhiteboard(next);
    undoStack.current = [];
    redoStack.current = [];
    setHistoryVersion((n) => n + 1);
    setDoc(next);
    dropSelection();
  }, [value]);

  // Each finished edit is committed: the board as it was goes on the undo stack (unless nothing that's saved
  // changed), and its JSON goes out.
  useEffect(() => {
    if (busy || doc === discarded.current) return;
    const json = serializeWhiteboard(doc);
    if (doc !== committed.current) {
      if (json !== lastEmitted.current) {
        undoStack.current = [...undoStack.current.slice(1 - HISTORY_LIMIT), committed.current];
        redoStack.current = [];
        setHistoryVersion((n) => n + 1);
      }
      committed.current = doc;
    }
    if (json !== lastEmitted.current) {
      lastEmitted.current = json;
      onChangeRef.current?.(json);
    }
  }, [doc, busy]);

  const setStrokes = (update: (strokes: Stroke[]) => Stroke[]) =>
    setDoc((d) => {
      const strokes = update(d.strokes);
      return strokes === d.strokes ? d : { ...d, strokes };
    });
  const setElements = (update: (elements: FloatingElement[]) => FloatingElement[]) =>
    setDoc((d) => {
      const elements = update(d.elements);
      return elements === d.elements ? d : { ...d, elements };
    });
  const setComments = (update: (comments: Comment[]) => Comment[]) => setDoc((d) => ({ ...d, comments: update(d.comments) }));

  /** Whether a drag is under way, during which the history can't move. */
  const dragging = () => !!(drawing.current || erasing.current || selecting.current || transforming.current);

  function undo() {
    if (busy || dragging()) return;
    cancelText();
    const previous = undoStack.current.pop();
    if (!previous) return;
    redoStack.current.push(committed.current);
    committed.current = previous;
    setHistoryVersion((n) => n + 1);
    setDoc(previous);
    dropSelection();
  }

  function redo() {
    if (busy || dragging()) return;
    cancelText();
    const next = redoStack.current.pop();
    if (!next) return;
    undoStack.current.push(committed.current);
    committed.current = next;
    setHistoryVersion((n) => n + 1);
    setDoc(next);
    dropSelection();
  }

  function dropSelection() {
    setSelected(new Set());
    setSelectedElements(new Set());
    setHover(null);
  }

  /** Swap strokes for others (a transformed or recoloured one for each), keeping them selected. */
  function replaceStrokes(next: Map<Stroke, Stroke>) {
    setStrokes((all) => all.map((s) => next.get(s) ?? s));
    setSelected((picked) => new Set([...picked].map((s) => next.get(s) ?? s)));
  }

  function deleteSelection() {
    const strokes = new Set(selection);
    const elements = new Set(pickedElements.map((e) => e.id));
    setDoc((d) => ({
      ...d,
      strokes: strokes.size ? d.strokes.filter((s) => !strokes.has(s)) : d.strokes,
      elements: elements.size ? normalizeZ(d.elements.filter((e) => !elements.has(e.id))) : d.elements,
    }));
    setSelected(new Set());
    setSelectedElements(new Set());
  }

  /** Lock the selection into the background, as a new layer behind everything else. */
  function lockSelection() {
    if (!selection.length && !pickedElements.length) return;
    const strokes = new Set(selection);
    const elements = new Set(pickedElements.map((e) => e.id));
    setDoc((d) => {
      const layers = d.lockedLayers ?? [];
      const layer: LockedLayer = {
        id: newId(),
        name: `Locked Layer ${layers.length + 1}`,
        strokes: d.strokes.filter((s) => strokes.has(s)),
        elements: normalizeZ(d.elements.filter((e) => elements.has(e.id))),
      };
      if (!layer.strokes.length && !layer.elements.length) return d;
      return {
        ...d,
        strokes: layer.strokes.length ? d.strokes.filter((s) => !strokes.has(s)) : d.strokes,
        elements: layer.elements.length ? normalizeZ(d.elements.filter((e) => !elements.has(e.id))) : d.elements,
        lockedLayers: [...layers, layer],
      };
    });
    dropSelection();
  }

  /** Unlock a layer: its strokes and elements go back on the board, in front, and are picked to show what came back. */
  function unlockLayer(id: string) {
    const layer = lockedLayers.find((l) => l.id === id);
    if (!layer || busy || dragging()) return;
    commitText();
    setDoc((d) => {
      const rest = (d.lockedLayers ?? []).filter((l) => l.id !== id);
      return {
        ...d,
        strokes: [...d.strokes, ...layer.strokes],
        elements: normalizeZ([...d.elements, ...layer.elements.map((e) => ({ ...e, z: d.elements.length + e.z }))]),
        lockedLayers: rest.length ? rest : undefined,
      };
    });
    setTool("select");
    setSelected(new Set(layer.strokes));
    setSelectedElements(new Set(layer.elements.map((e) => e.id)));
    if (lockedLayers.length <= 1) setLayersMenu(false);
  }

  // ---- The view ----

  useEffect(() => {
    if (autoFocus) rootRef.current?.focus({ preventScroll: true });
  }, []);

  // The stage's size, which the markup canvas matches.
  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const measure = () => setStageSize((s) => (s.width === stage.clientWidth && s.height === stage.clientHeight ? s : { width: stage.clientWidth, height: stage.clientHeight }));
    const observer = new ResizeObserver(measure);
    observer.observe(stage);
    measure();
    return () => observer.disconnect();
  }, []);

  // The board's fitted to the stage once it's first laid out.
  useLayoutEffect(() => {
    if (fitted.current || !stageSize.width || !stageSize.height) return;
    fitted.current = true;
    fit();
  }, [stageSize]);

  /** Fit the view to the board's content (at most at 100%), or center its origin if it's empty. */
  function fit() {
    const { width, height } = stageSizeRef.current;
    const bounds = contentBounds(doc);
    if (!bounds) return setView({ zoom: 1, x: width / 2, y: height / 2 });
    const w = Math.max(bounds.right - bounds.left, 1);
    const h = Math.max(bounds.bottom - bounds.top, 1);
    const room = (side: number) => Math.max(side - FIT_PADDING * 2, side / 2);
    const zoom = clampZoom(Math.min(1, room(width) / w, room(height) / h));
    setView({ zoom, x: width / 2 - (bounds.left + w / 2) * zoom, y: height / 2 - (bounds.top + h / 2) * zoom });
  }

  /** Zoom to `zoom`, keeping the world's point under `at` (client coordinates; the stage's center by default) there. */
  function zoomTo(zoom: number, at?: Point) {
    const stage = stageRef.current?.getBoundingClientRect();
    if (!stage) return;
    setView((v) => {
      const z = clampZoom(zoom);
      const px = at ? at.x - stage.left : stage.width / 2;
      const py = at ? at.y - stage.top : stage.height / 2;
      return { zoom: z, x: px - ((px - v.x) * z) / v.zoom, y: py - ((py - v.y) * z) / v.zoom };
    });
  }

  // React's wheel listener is passive, so it can't keep the page from scrolling: the stage's own is added here.
  // Ctrl/Cmd+wheel (and a trackpad's pinch, which sends it) zooms; the wheel pans if the board takes it.
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const wheel = (e: WheelEvent) => {
      const scale = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? stage.clientHeight : 1;
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        zoomTo(viewRef.current.zoom * Math.exp((-e.deltaY * scale) / 300), { x: e.clientX, y: e.clientY });
      } else if (captureWheelRef.current) {
        e.preventDefault();
        const dx = (e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX) * scale;
        const dy = (e.shiftKey && !e.deltaX ? 0 : e.deltaY) * scale;
        setView((v) => ({ ...v, x: v.x - dx, y: v.y - dy }));
      }
    };
    stage.addEventListener("wheel", wheel, { passive: false });
    return () => stage.removeEventListener("wheel", wheel);
  }, []);

  /** A point on the stage (client coordinates) in world units. */
  function worldPoint(e: { clientX: number; clientY: number }): Point | null {
    const stage = stageRef.current?.getBoundingClientRect();
    if (!stage) return null;
    const v = viewRef.current;
    return { x: (e.clientX - stage.left - v.x) / v.zoom, y: (e.clientY - stage.top - v.y) / v.zoom };
  }

  /** The world's point at the stage's center. */
  function stageCenter(): Point {
    const { width, height } = stageSizeRef.current;
    const v = viewRef.current;
    return { x: (width / 2 - v.x) / v.zoom, y: (height / 2 - v.y) / v.zoom };
  }

  // ---- Tools and keys ----

  // The selection is the select tool's: another tool drops it.
  useEffect(() => {
    if (tool === "select") return;
    dropSelection();
  }, [tool]);

  // A board that stops being editable (a note published) puts its tools down; one that becomes editable takes the pen.
  useEffect(() => {
    if (editable) return setTool((t) => (t === "pan" ? "draw" : t));
    cancelText();
    setNewComment(null);
    dropSelection();
    setTool("pan");
  }, [editable]);

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

  function pickTool(next: Tool) {
    commitText();
    setTool(next);
  }

  /** Escape: drop the text being typed, or close the eraser's menu or the open comment, or drop the selection, or
   * else hand it on; whether it did anything. */
  function escape(): boolean {
    if (textEntryRef.current) cancelText();
    else if (eraserMenu) setEraserMenu(false);
    else if (layersMenu) setLayersMenu(false);
    else if (newComment || expanded) {
      setNewComment(null);
      setExpanded(null);
    } else if (frame && !dragging()) dropSelection();
    else if (onEscape) onEscape();
    else return false;
    return true;
  }

  function keyDown(e: ReactKeyboardEvent) {
    if (isTyping(e.target)) return;
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    let handled = true;
    if (e.key === "Escape") handled = escape();
    else if (!editable) handled = false;
    else if (mod && key === "z") e.shiftKey ? redo() : undo();
    else if (mod && key === "y") redo();
    else if (mod && key === "s") onSave?.();
    else if (e.key === "Delete" || e.key === "Backspace") {
      if (!frame || dragging()) handled = false;
      else deleteSelection();
    } else if (e.key === " ") {
      if (!e.repeat) setSpaceHeld(true);
    } else if (e.key === "Shift") {
      // Holding Shift swaps the tool for the eraser, and letting go swaps it back (unless another was picked).
      handled = false;
      if (!e.repeat && !shiftFrom.current && !isEraser(toolRef.current) && !dragging()) {
        shiftFrom.current = toolRef.current;
        setTool(eraserRef.current);
      }
    } else if (!mod && !e.altKey && !e.shiftKey && key === "g") toggleGrid();
    else if (!mod && !e.altKey && !e.shiftKey && SHORTCUTS[key]) pickTool(key === "e" ? eraserRef.current : SHORTCUTS[key]);
    else handled = false;
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  }

  function releaseShift() {
    const from = shiftFrom.current;
    shiftFrom.current = null;
    if (from && isEraser(toolRef.current)) setTool(from);
  }

  function keyUp(e: ReactKeyboardEvent) {
    if (e.key === " ") setSpaceHeld(false);
    if (e.key === "Shift") releaseShift();
  }

  function toggleGrid() {
    setDoc((d) => ({ ...d, grid: !d.grid }));
  }

  // ---- Floating elements ----

  /** The topmost floating element at a point. */
  function elementAt(point: Point): FloatingElement | null {
    let top: FloatingElement | null = null;
    for (const e of doc.elements) {
      const p = toElementFrame(e, point);
      if (p.x >= e.x && p.x <= e.x + e.w && p.y >= e.y && p.y <= e.y + e.h && (!top || e.z > top.z)) top = e;
    }
    return top;
  }

  /** Upload images and PDFs and pin them on the board, centered on `at` (the stage's center by default), each a
   * little below and right of the last, sized to fit the stage. */
  async function insertFiles(files: File[], at?: Point | null) {
    if (!canInsert || spaceId === undefined) return;
    setError(null);
    const center = at ?? stageCenter();
    let placed = 0;
    for (const file of files) {
      const pdf = isPdfFile(file);
      if (!pdf && !isImageFile(file)) {
        setError(`${file.name} isn't an image or a PDF.`);
        continue;
      }
      const offset = placed++ * 24;
      setUploads((n) => n + 1);
      try {
        const { url } = await uploadFile(spaceId, file);
        const natural = pdf ? await pdfPageSize(url, 0) : await imageSize(url);
        const v = viewRef.current;
        const { width, height } = stageSizeRef.current;
        const scale = Math.min(1 / v.zoom, (width * INSERT_FIT) / v.zoom / natural.width, (height * INSERT_FIT) / v.zoom / natural.height);
        const w = natural.width * scale;
        const h = natural.height * scale;
        const element: FloatingElement = {
          id: newId(),
          kind: pdf ? "pdf" : "image",
          src: url,
          ...(pdf && { page: 0 }),
          x: center.x - w / 2 + offset / v.zoom,
          y: center.y - h / 2 + offset / v.zoom,
          w,
          h,
          z: 0,
        };
        setDoc((d) => ({ ...d, elements: normalizeZ([...d.elements, { ...element, z: d.elements.length }]) }));
        setTool("select");
        setSelected(new Set());
        setSelectedElements(new Set([element.id]));
      } catch (err) {
        setError(`Could not add ${file.name} (${message(err)}).`);
      } finally {
        setUploads((n) => n - 1);
      }
    }
  }

  /** Show another page of a pinned PDF, keeping its width and taking that page's shape. */
  async function setElementPage(id: string, page: number) {
    const element = doc.elements.find((e) => e.id === id);
    if (!element || element.kind !== "pdf") return;
    const { promise, release } = acquirePdf(element.src);
    try {
      const pdf = await promise;
      const next = Math.min(Math.max(0, Math.round(page)), pdf.numPages - 1);
      const viewport = (await pdf.getPage(next + 1)).getViewport({ scale: 1 });
      setElements((all) => all.map((e) => (e.id === id ? { ...e, page: next, h: (e.w * viewport.height) / viewport.width } : e)));
    } catch (err) {
      setError(`Could not show page ${page + 1} (${message(err)}).`);
    } finally {
      release();
    }
  }

  function restackSelected(move: "forward" | "backward" | "front" | "back") {
    const ids = new Set(pickedElements.map((e) => e.id));
    if (ids.size) setElements((all) => restack(all, ids, move));
  }

  // ---- Drawing ----

  // The canvas shows the strokes, over the elements, and the selection's box: redrawn whole when they or the view
  // change. Before paint, so a pan or zoom doesn't flash it blank.
  useLayoutEffect(redraw, [doc.strokes, doc.elements, doc.lockedLayers, selected, selectedElements, view, stageSize, busy]);

  /** Redraw the canvas whole, with the stroke being drawn, the lasso being drawn and the selection's box. */
  function redraw() {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    const ratio = canvas.width / Math.max(1, stageSize.width);
    context.resetTransform();
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.setTransform(ratio * view.zoom, 0, 0, ratio * view.zoom, ratio * view.x, ratio * view.y);
    // The locked layers' strokes, first, under the board's own.
    for (const layer of doc.lockedLayers ?? []) drawStrokes(context, layer.strokes);
    const current = drawing.current?.stroke;
    drawStrokes(context, current ? [...doc.strokes, current] : doc.strokes);
    if (selecting.current) drawLassoOutline(context, selecting.current.points, view.zoom);
    // While it's turned, the box it started in is drawn turned with it (the box around it now would grow and shrink).
    const transform = transforming.current;
    if (transform?.handle === "rotate") drawSelection(context, transform.box, view.zoom, transform.boxAngle + transform.angle);
    else if (frame) drawSelection(context, frame.box, view.zoom, frame.angle);
  }

  // The canvas covers the stage in device pixels, within a canvas's limits.
  const pixelRatio = Math.min(
    window.devicePixelRatio || 1,
    Math.sqrt(MAX_CANVAS_AREA / Math.max(1, stageSize.width * stageSize.height)),
  );
  const canvasWidth = Math.max(1, Math.round(stageSize.width * pixelRatio));
  const canvasHeight = Math.max(1, Math.round(stageSize.height * pixelRatio));

  /** A stroke's width in world units: the line size on screen at the current zoom. */
  const lineWidth = lineSize / view.zoom;
  const freehandPoint = (point: Point, pointerType: string, pressure: number) =>
    pointerType === "pen" ? { ...point, width: lineWidth, pressure } : { ...point, width: lineWidth };

  /** Delete the strokes whose ink passes within the stroke eraser's reach of a point. */
  function eraseAt(point: Point, reach: number) {
    setStrokes((all) => {
      const kept = all.filter((s) => !touches(s, point, reach));
      return kept.length === all.length ? all : kept;
    });
  }

  // ---- Pointers ----

  /** Whether a pointer marks the board: while it's editable, a pen or the mouse with any tool but Move. Touch
   * always pans. */
  const draws = (e: ReactPointerEvent) => editable && activeTool !== "pan" && (e.pointerType === "pen" || e.pointerType === "mouse");

  /** Start a drag of the selection's `handle`: the strokes and elements given, in the selection's box (as `frame`). */
  function startTransform(strokes: Stroke[], elements: FloatingElement[], frame: { box: Box; angle: number }, handle: Handle, from: Point, pointerId: number) {
    const smallest = Math.min(...elements.map((e) => Math.min(e.w, e.h)));
    const min = elements.length ? Math.min(1, MIN_ELEMENT_SIDE / view.zoom / smallest) : 0;
    transforming.current = { pointerId, handle, from, box: frame.box, boxAngle: frame.angle, originals: strokes, current: strokes, elements, angle: 0, min, moved: false };
    setBusy(true);
  }

  /** Pick just one stroke or element, and start dragging it. */
  function pickAndDrag(strokes: Stroke[], elements: FloatingElement[], from: Point, pointerId: number) {
    setSelected(new Set(strokes));
    setSelectedElements(new Set(elements.map((e) => e.id)));
    const picked = selectionFrame(strokes, elements);
    if (picked) startTransform(strokes, elements, picked, "move", from, pointerId);
  }

  /** The select tool's press: on the selection's handles, transform all of it; on a stroke or an element, pick it
   * (and drag it); anywhere else, drop the selection and start a lasso. */
  function selectDown(point: Point, pointerId: number) {
    const { zoom } = view;
    if (frame) {
      // Its handles turn with it: the point's turned back to meet them on its upright box.
      const handle = selectionHandle(frame.box, toSelectionFrame(frame, point), zoom);
      if (handle) return startTransform(selection, pickedElements, frame, handle, point, pointerId);
    }
    // Ink is drawn over the elements, so it's picked first.
    const reach = ERASER_MIN_REACH / zoom;
    const stroke = [...doc.strokes].reverse().find((s) => touches(s, point, reach));
    if (stroke) return pickAndDrag([stroke], [], point, pointerId);
    const element = elementAt(point);
    if (element) return pickAndDrag([], [element], point, pointerId);
    dropSelection();
    selecting.current = { pointerId, points: [point], erase: false };
  }

  function pointerDown(e: ReactPointerEvent) {
    const middle = e.pointerType === "mouse" && e.button === 1;
    if (e.pointerType === "mouse" && e.button !== 0 && !middle) return;
    rootRef.current?.focus({ preventScroll: true });
    if (middle) e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    if (!middle && draws(e)) {
      const point = worldPoint(e);
      if (!point || dragging()) return;
      if (eraserMenu) setEraserMenu(false);
      if (tool === "erase") {
        // Deletes every stroke it touches, here and along its drag.
        const reach = Math.max(lineSize, ERASER_MIN_REACH) / view.zoom;
        erasing.current = { pointerId: e.pointerId, reach };
        setBusy(true);
        eraseAt(point, reach);
        return;
      }
      if (tool === "lasso-erase") {
        selecting.current = { pointerId: e.pointerId, points: [point], erase: true };
        return;
      }
      if (tool === "select") return selectDown(point, e.pointerId);
      if (tool === "comment") {
        // A click pins a comment, open to be written in; it's kept once it's saved with something in it.
        commitText();
        setExpanded(null);
        setNewComment({ id: newId(), x: point.x, y: point.y, text: "", isExpanded: true, page: 0 });
        return;
      }
      if (tool === "text") {
        // A click places a text, or, while one's being typed, just finishes it.
        if (textEntryRef.current) commitText();
        else setTextEntry({ ...point, size: textSize(lineSize) / view.zoom, color: ink, value: "" });
        return;
      }
      if (tool === "pan") return;
      const stroke: Stroke = isShape(tool)
        ? { type: tool, color: ink, points: [{ ...point, width: lineWidth }] }
        : { type: tool, color: ink, points: [freehandPoint(point, e.pointerType, e.pressure)], taper: e.pointerType === "pen" ? "pen" : "speed" };
      drawing.current = { pointerId: e.pointerId, stroke };
      // A shape shows once it's dragged.
      if (!isShape(tool)) redraw();
      return;
    }
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    setPanning(true);
  }

  /** Whether a drag from `from` to `to` has gone far enough to move anything. */
  const pastThreshold = (from: Point, to: Point) => distance(from, to) * view.zoom >= DRAG_THRESHOLD;

  function pointerMove(e: ReactPointerEvent) {
    const current = drawing.current;
    if (current?.pointerId === e.pointerId) {
      const { stroke } = current;
      if (isShape(stroke.type)) {
        const point = worldPoint(e);
        if (!point) return;
        stroke.points[1] = { ...point, width: stroke.points[0].width };
        redraw();
        return;
      }
      // A pen reports more points than it fires events for; they're all kept, for a smooth line.
      const events = e.nativeEvent.getCoalescedEvents?.() ?? [];
      for (const event of events.length ? events : [e.nativeEvent]) {
        const point = worldPoint(event);
        if (point) stroke.points.push(freehandPoint(point, e.pointerType, event.pressure));
      }
      redraw();
      return;
    }
    const eraser = erasing.current;
    if (eraser?.pointerId === e.pointerId) {
      const events = e.nativeEvent.getCoalescedEvents?.() ?? [];
      for (const event of events.length ? events : [e.nativeEvent]) {
        const point = worldPoint(event);
        if (point) eraseAt(point, eraser.reach);
      }
      return;
    }
    const transform = transforming.current;
    if (transform?.pointerId === e.pointerId) {
      // Transformed from the strokes and elements as they were when the drag started, so its steps' rounding doesn't
      // add up. An element scaled keeps its shape.
      const point = worldPoint(e);
      if (!point || (!transform.moved && !pastThreshold(transform.from, point))) return;
      transform.moved = true;
      const next = transformGroup(transform.originals, transform.elements, transform.box, transform.boxAngle, transform.handle, transform.from, point, transform.min);
      transform.angle = next.angle;
      if (next.strokes.length) replaceStrokes(new Map(transform.current.map((s, i) => [s, next.strokes[i]])));
      transform.current = next.strokes;
      const moved = new Map(next.frames.map((el) => [el.id, el]));
      if (moved.size) setElements((all) => all.map((el) => moved.get(el.id) ?? el));
      return;
    }
    const lassoing = selecting.current;
    if (lassoing?.pointerId === e.pointerId) {
      const events = e.nativeEvent.getCoalescedEvents?.() ?? [];
      for (const event of events.length ? events : [e.nativeEvent]) {
        const point = worldPoint(event);
        if (point) lassoing.points.push(point);
      }
      redraw();
      return;
    }
    if (tool === "select" && draws(e) && !pointers.current.has(e.pointerId)) {
      // Hovering: the cursor shows what a drag from here would do.
      const point = worldPoint(e);
      setHover(point ? hoverCursor(point) : null);
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
    setView((v) => {
      const zoom = clampZoom((v.zoom * after.distance) / before.distance);
      const from = { x: before.mid.x - stage.left, y: before.mid.y - stage.top };
      const to = { x: after.mid.x - stage.left, y: after.mid.y - stage.top };
      return { zoom, x: to.x - ((from.x - v.x) * zoom) / v.zoom, y: to.y - ((from.y - v.y) * zoom) / v.zoom };
    });
  }

  /** The cursor over a point with the select tool. */
  function hoverCursor(point: Point): string | null {
    const handle = frame && selectionHandle(frame.box, toSelectionFrame(frame, point), view.zoom);
    if (handle) return HANDLE_CURSORS[handle];
    return elementAt(point) ? "cursor-move" : null;
  }

  function pointerUp(e: ReactPointerEvent) {
    pointers.current.delete(e.pointerId);
    if (!pointers.current.size) setPanning(false);
    if (transforming.current?.pointerId === e.pointerId) {
      transforming.current = null;
      setBusy(false);
      // A turned selection's box was drawn turned; it's redrawn around where everything is now.
      setSelected((picked) => new Set(picked));
      return;
    }
    if (erasing.current?.pointerId === e.pointerId) {
      erasing.current = null;
      setBusy(false);
      return;
    }
    const lassoing = selecting.current;
    if (lassoing?.pointerId === e.pointerId) {
      selecting.current = null;
      // A lasso picks (or the lasso eraser deletes) the strokes it wholly encloses and the floating elements whose
      // centers it encloses, all together; one that encloses nothing (a click) just clears its outline.
      if (lassoing.points.length < 3) return redraw();
      const inside = new Set(doc.strokes.filter((s) => lassoed(s, lassoing.points)));
      const caught = doc.elements.filter((el) => insideLoop(frameCenter(el), lassoing.points));
      if (!lassoing.erase) {
        setSelected(inside);
        setSelectedElements(new Set(caught.map((el) => el.id)));
      } else if (inside.size || caught.length) {
        const gone = new Set(caught.map((el) => el.id));
        setDoc((d) => ({
          ...d,
          strokes: inside.size ? d.strokes.filter((s) => !inside.has(s)) : d.strokes,
          elements: gone.size ? normalizeZ(d.elements.filter((el) => !gone.has(el.id))) : d.elements,
        }));
        setSelectedElements((picked) => (gone.size ? new Set([...picked].filter((id) => !gone.has(id))) : picked));
        if (!inside.size) redraw();
      } else redraw();
      return;
    }
    const current = drawing.current;
    if (current?.pointerId !== e.pointerId) return;
    drawing.current = null;
    // A shape that was never dragged isn't one.
    if (isShape(current.stroke.type) && current.stroke.points.length < 2) return redraw();
    setStrokes((s) => [...s, current.stroke]);
  }

  // ---- Dropping and pasting files ----

  const hasFiles = (e: ReactDragEvent) => e.dataTransfer.types.includes("Files");

  function dragOver(e: ReactDragEvent) {
    if (!canInsert || !hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    setDropping(true);
  }

  function drop(e: ReactDragEvent) {
    setDropping(false);
    if (!canInsert || !hasFiles(e)) return;
    e.preventDefault();
    void insertFiles(Array.from(e.dataTransfer.files), worldPoint(e));
  }

  // ---- Rendering ----

  const cursor =
    activeTool === "pan"
      ? panning
        ? "cursor-grabbing"
        : "cursor-grab"
      : tool === "text"
        ? "cursor-text"
        : tool === "select"
          ? (hover ?? "cursor-default")
          : "cursor-crosshair";

  const world: CSSProperties = { transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})`, transformOrigin: "0 0" };
  const stacked = [...doc.elements].sort((a, b) => a.z - b.z);
  const transformingNow = busy && !!transforming.current;
  const status = uploads > 0 ? `Uploading ${uploads > 1 ? `${uploads} files` : "file"}…` : null;

  return (
    <div
      ref={rootRef}
      tabIndex={0}
      role="application"
      aria-label="Whiteboard"
      aria-roledescription="whiteboard"
      onKeyDown={keyDown}
      onKeyUp={keyUp}
      // A press held to draw mustn't start the browser's (or the note editor's) own drag of the board.
      draggable={false}
      onDragStart={preventDrag}
      onBlur={(e) => {
        // Keys let go elsewhere never come up here.
        if (rootRef.current?.contains(e.relatedTarget as Node | null)) return;
        setSpaceHeld(false);
        releaseShift();
      }}
      onPaste={(e) => {
        if (!canInsert || isTyping(e.target)) return;
        const files = Array.from(e.clipboardData.files);
        if (!files.length) return;
        e.preventDefault();
        void insertFiles(files);
      }}
      className={`flex min-h-0 flex-col overflow-hidden bg-background outline-none ${className}`}
    >
      {editable && (
        <div role="toolbar" aria-label="Whiteboard tools" className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-border-default px-3 py-1.5">
          <MarkupTools
            tool={tool}
            onTool={pickTool}
            eraser={eraser}
            onEraser={setEraser}
            eraserMenu={eraserMenu}
            onEraserMenu={setEraserMenu}
            ink={ink}
            onInk={(value) => {
              setInk(value);
              // Picking ink recolours the picked strokes, or else swaps Move, Select or an eraser for the pen.
              if (tool === "select" && selection.length) replaceStrokes(new Map(selection.map((s) => [s, { ...s, color: value }])));
              else if (tool === "pan" || tool === "select" || isEraser(tool)) pickTool("draw");
            }}
            lineSize={lineSize}
            onLineSize={setLineSize}
          />
          <ToolbarDivider />
          <Segment on={false} label="Undo (Ctrl+Z)" disabled={!undoStack.current.length || busy} onClick={undo}>
            <ToolIcon path="M5.5 3.5L2.5 6.5l3 3 M2.5 6.5h7a4 4 0 0 1 0 8h-3" />
          </Segment>
          <Segment on={false} label="Redo (Ctrl+Shift+Z)" disabled={!redoStack.current.length || busy} onClick={redo}>
            <ToolIcon path="M10.5 3.5l3 3-3 3 M13.5 6.5h-7a4 4 0 0 0 0 8h3" />
          </Segment>
          <ToolbarDivider />
          {canInsert && (
            <>
              <Segment on={false} label="Insert an image or PDF (or drop or paste one)" disabled={uploads > 0} onClick={() => fileInputRef.current?.click()}>
                <span className="flex items-center gap-1.5">
                  <ToolIcon path="M2.5 3.5h11v9h-11z M2.5 10.5l3-3 2.5 2.5 2-2 3.5 3.5 M10.5 6a1 1 0 1 0 0-.01" />
                  <span className="text-[14px]">Insert media</span>
                </span>
              </Segment>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept="image/*,application/pdf,.pdf"
                className="hidden"
                onChange={(e) => {
                  const files = Array.from(e.target.files ?? []);
                  e.target.value = "";
                  if (files.length) void insertFiles(files);
                }}
              />
            </>
          )}
          <Segment on={doc.grid} label="Grid (G)" onClick={toggleGrid}>
            <ToolIcon path="M2.5 2.5h11v11h-11z M6.2 2.5v11 M9.8 2.5v11 M2.5 6.2h11 M2.5 9.8h11" />
          </Segment>
          {lockedLayers.length > 0 && (
            <>
              <span ref={layersButtonRef} className="flex">
                <Segment on={layersMenu} label="Locked layers" onClick={() => setLayersMenu((open) => !open)}>
                  <span className="flex items-center gap-1.5">
                    <ToolIcon path={LOCK_ICON} />
                    <span className="text-[14px]">Locked layers</span>
                    <span className="font-mono text-xs text-text-muted">{lockedLayers.length}</span>
                  </span>
                </Segment>
              </span>
              <Popover anchor={layersButtonRef} open={layersMenu} onClose={() => setLayersMenu(false)} label="Locked layers" role="menu">
                {lockedLayers.map((layer) => (
                  <div key={layer.id} className="flex items-center gap-3 rounded-md px-2 py-1">
                    <span className="min-w-0 flex-1 truncate text-text-secondary">{layer.name}</span>
                    <button
                      type="button"
                      role="menuitem"
                      aria-label={`Unlock ${layer.name}`}
                      onClick={() => unlockLayer(layer.id)}
                      className="rounded px-2 py-0.5 text-xs text-text-secondary hover:bg-surface-raised hover:text-text-primary focus:bg-surface-raised focus:outline-none"
                    >
                      Unlock
                    </button>
                  </div>
                ))}
              </Popover>
            </>
          )}
          <span className="ml-auto flex items-center gap-2">
            {status && (
              <span role="status" className="text-xs text-text-muted">
                {status}
              </span>
            )}
            {toolbarEnd}
          </span>
        </div>
      )}
      {error && (
        <p role="alert" className="flex shrink-0 items-center gap-2 border-b border-border-default px-3 py-1 text-[14px] text-accent">
          {error}
          <button type="button" className="ml-auto text-xs text-text-muted hover:text-text-primary" onClick={() => setError(null)}>
            Dismiss
          </button>
        </p>
      )}
      <div
        ref={stageRef}
        data-whiteboard-stage
        className={`relative min-h-0 flex-1 touch-none select-none overflow-hidden ${cursor} ${dropping ? "ring-2 ring-inset ring-accent/70" : ""}`}
        style={doc.grid ? gridStyle(view) : undefined}
        onPointerDown={pointerDown}
        onPointerMove={pointerMove}
        onPointerUp={pointerUp}
        onPointerCancel={pointerUp}
        onPointerLeave={() => setHover(null)}
        draggable={false}
        onDragStart={preventDrag}
        onDoubleClick={() => (!editable || tool === "pan") && fit()}
        onDragOver={dragOver}
        onDragLeave={() => setDropping(false)}
        onDrop={drop}
      >
        {/* The floating elements, back to front (the locked layers' first, behind the rest), under the markup. */}
        <div aria-hidden className="pointer-events-none absolute left-0 top-0" style={world}>
          {lockedLayers.map((layer) =>
            [...layer.elements].sort((a, b) => a.z - b.z).map((element) => <BoardElement key={element.id} element={element} zoom={view.zoom} />),
          )}
          {stacked.map((element) => (
            <BoardElement key={element.id} element={element} zoom={view.zoom} />
          ))}
        </div>
        <canvas ref={canvasRef} width={canvasWidth} height={canvasHeight} className="pointer-events-none absolute inset-0 h-full w-full" />
        {/* Over the markup: comments and the text being typed, in world units too. */}
        <div className="absolute left-0 top-0" style={world}>
          {editable && textEntry && (
            <input
              ref={textInputRef}
              aria-label="Text"
              value={textEntry.value}
              onChange={(e) => setTextEntry({ ...textEntry, value: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  commitText();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  e.stopPropagation();
                  cancelText();
                  rootRef.current?.focus({ preventScroll: true });
                }
              }}
              onBlur={commitText}
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
          {doc.comments.map((c) => (
            <CommentPin
              key={c.id}
              comment={{ ...c, isExpanded: expanded === c.id }}
              zoom={view.zoom}
              editable={editable}
              onToggle={() => {
                setNewComment(null);
                setExpanded((id) => (id === c.id ? null : c.id));
              }}
              onSave={(text) => {
                setExpanded(null);
                setComments((all) => (text.trim() ? all.map((x) => (x.id === c.id ? { ...x, text } : x)) : all.filter((x) => x.id !== c.id)));
              }}
              onDelete={() => {
                setExpanded(null);
                setComments((all) => all.filter((x) => x.id !== c.id));
              }}
            />
          ))}
          {newComment && (
            <CommentPin
              key={newComment.id}
              comment={newComment}
              zoom={view.zoom}
              editable
              onToggle={() => setNewComment(null)}
              onSave={(text) => {
                setNewComment(null);
                if (text.trim()) setComments((all) => [...all, { ...newComment, text, isExpanded: false }]);
              }}
              onDelete={() => setNewComment(null)}
            />
          )}
        </div>
        {frame && editable && !transformingNow && (
          <ElementToolbar
            elements={pickedElements}
            extent={selectionExtent(frame.box, frame.angle, view.zoom)}
            view={view}
            stageWidth={stageSize.width}
            onRestack={restackSelected}
            onPage={(id, page) => void setElementPage(id, page)}
            onOpen={setOpened}
            onLock={lockSelection}
            onDelete={deleteSelection}
          />
        )}
        {isEmpty && editable && (
          <p className="pointer-events-none absolute inset-x-0 top-1/2 -translate-y-1/2 px-6 text-center text-[15px] text-text-muted">
            Draw with the pen and shapes{canInsert ? ", or drop images and PDFs here" : ""}.
          </p>
        )}
        {!editable && toolbarEnd && (
          <div className="absolute right-2 top-2 flex items-center gap-1" onPointerDown={(e) => e.stopPropagation()}>
            {toolbarEnd}
          </div>
        )}
        <div
          className="absolute bottom-2 right-2 flex items-center gap-0.5 rounded-lg border border-border-default bg-surface-raised/90 px-1 py-0.5 shadow-lg"
          onPointerDown={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
        >
          <Segment on={false} label="Zoom out" onClick={() => zoomTo(view.zoom / ZOOM_STEP)}>
            −
          </Segment>
          <button
            type="button"
            title="Zoom to 100%"
            aria-label="Zoom to 100%"
            onClick={() => zoomTo(1)}
            className="w-12 rounded py-1 text-center font-mono text-xs text-text-secondary hover:bg-surface-hover hover:text-text-primary"
          >
            {Math.round(view.zoom * 100)}%
          </button>
          <Segment on={false} label="Zoom in" onClick={() => zoomTo(view.zoom * ZOOM_STEP)}>
            +
          </Segment>
          <Segment on={false} label="Fit to the content" onClick={fit}>
            <ToolIcon path="M2.5 6V2.5H6 M10 2.5h3.5V6 M13.5 10v3.5H10 M6 13.5H2.5V10" />
          </Segment>
        </div>
      </div>
      {opened && <MediaLightbox src={opened.src} onClose={() => setOpened(null)} editable={editable} />}
    </div>
  );
}

/** A floating element's CSS turn, about its box's center. */
const rotation = (e: FloatingElement) => (e.angle ? `rotate(${e.angle}rad)` : undefined);

/** A padlock, for locking into the background and the locked layers. */
const LOCK_ICON = "M3.5 7.5h9v6h-9z M5.5 7.5V5a2.5 2.5 0 0 1 5 0v2.5";

/** A floating element on the stage, in its box. */
function BoardElement({ element, zoom }: { element: FloatingElement; zoom: number }) {
  return (
    <div
      className="absolute overflow-hidden shadow-lg shadow-black/40"
      style={{ left: element.x, top: element.y, width: element.w, height: element.h, transform: rotation(element) }}
    >
      {element.kind === "pdf" ? (
        <PdfPage src={element.src} page={element.page ?? 0} width={element.w} zoom={zoom} />
      ) : (
        <ImageElement src={element.src} />
      )}
    </div>
  );
}

/** Stops a native drag starting from the board: a press held to draw would otherwise pick it up. */
function preventDrag(e: ReactDragEvent) {
  e.preventDefault();
  e.stopPropagation();
}

/** The blueprint grid, as the stage's background: minor lines every cell and major ones every `GRID_MAJOR`, moving
 * and scaling with the view, coarsening as it zooms out so the lines never crowd. */
function gridStyle(view: View): CSSProperties {
  let cell = GRID * view.zoom;
  while (cell < GRID_MIN_CELL) cell *= GRID_MAJOR;
  const major = cell * GRID_MAJOR;
  const minorLine = "rgba(108, 182, 234, 0.09)";
  const majorLine = "rgba(108, 182, 234, 0.2)";
  const at = `${view.x}px ${view.y}px`;
  return {
    backgroundImage: [
      `linear-gradient(to right, ${majorLine} 1px, transparent 1px)`,
      `linear-gradient(to bottom, ${majorLine} 1px, transparent 1px)`,
      `linear-gradient(to right, ${minorLine} 1px, transparent 1px)`,
      `linear-gradient(to bottom, ${minorLine} 1px, transparent 1px)`,
    ].join(", "),
    backgroundSize: `${major}px ${major}px, ${major}px ${major}px, ${cell}px ${cell}px, ${cell}px ${cell}px`,
    backgroundPosition: [at, at, at, at].join(", "),
  };
}

/**
 * The selection's mini-toolbar, over it (or under it, if it's near the stage's top): restack its elements, lock it
 * into the background or delete it, and, for an element picked alone, open it fullscreen or turn a PDF's page. In screen pixels,
 * so it stays the same size as the view zooms.
 */
function ElementToolbar({
  elements,
  extent,
  view,
  stageWidth,
  onRestack,
  onPage,
  onOpen,
  onLock,
  onDelete,
}: {
  elements: FloatingElement[];
  /** The box around the selection as it's shown and its rotate handle, in world units, which it keeps clear of. */
  extent: Box;
  view: View;
  stageWidth: number;
  onRestack: (move: "forward" | "backward" | "front" | "back") => void;
  onPage: (id: string, page: number) => void;
  onOpen: (element: FloatingElement) => void;
  onLock: () => void;
  onDelete: () => void;
}) {
  const element = elements.length === 1 ? elements[0] : null;
  const pdf = element?.kind === "pdf" ? element : null;
  const { doc } = usePdf(pdf?.src ?? null);
  const pages = doc?.numPages ?? null;
  const page = pdf?.page ?? 0;
  const [pageDraft, setPageDraft] = useState(String(page + 1));
  useEffect(() => setPageDraft(String(page + 1)), [page]);

  const top = extent.top * view.zoom + view.y;
  const bottom = extent.bottom * view.zoom + view.y;
  const above = top > 52;
  // Kept on the stage, roughly half its own width in from either side.
  const half = pdf ? 245 : element ? 145 : elements.length ? 125 : 45;
  const center = Math.min(Math.max(((extent.left + extent.right) / 2) * view.zoom + view.x, half), Math.max(half, stageWidth - half));

  function commitPage() {
    const next = Number(pageDraft);
    if (pdf && Number.isFinite(next) && next >= 1 && next - 1 !== page) onPage(pdf.id, next - 1);
    else setPageDraft(String(page + 1));
  }

  return (
    <div
      role="toolbar"
      aria-label={pdf ? "PDF" : element ? "Image" : "Selection"}
      className="absolute z-10 flex items-center gap-0.5 whitespace-nowrap rounded-lg border border-border-default bg-surface-raised px-1 py-0.5 shadow-xl"
      style={{ left: center, top: above ? top - 8 : bottom + 8, transform: `translate(-50%, ${above ? "-100%" : "0"})` }}
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      {elements.length > 0 && (
        <>
          <Segment on={false} label="Bring forward" onClick={() => onRestack("forward")}>
            <ToolIcon path="M5.5 5.5h8v8h-8z M2.5 10.5v-8h8" />
          </Segment>
          <Segment on={false} label="Send backward" onClick={() => onRestack("backward")}>
            <ToolIcon path="M10.5 5.5v-3h-8v8h3 M5.5 5.5h8v8h-8z" dashed />
          </Segment>
          <Segment on={false} label="Bring to front" onClick={() => onRestack("front")}>
            <ToolIcon path="M8 13.5v-9 M4.5 8L8 4.5 11.5 8 M3 2.5h10" />
          </Segment>
          <Segment on={false} label="Send to back" onClick={() => onRestack("back")}>
            <ToolIcon path="M8 2.5v9 M4.5 8L8 11.5 11.5 8 M3 13.5h10" />
          </Segment>
        </>
      )}
      {pdf && (
        <>
          <ToolbarDivider />
          <Segment on={false} label="Previous page" disabled={page <= 0} onClick={() => onPage(pdf.id, page - 1)}>
            ‹
          </Segment>
          <label className="flex items-center gap-1 font-mono text-xs text-text-secondary">
            <span className="sr-only">Page</span>
            <input
              aria-label="Set page"
              inputMode="numeric"
              value={pageDraft}
              onChange={(e) => setPageDraft(e.target.value.replace(/\D/g, ""))}
              onBlur={commitPage}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  commitPage();
                } else if (e.key === "Escape") {
                  e.stopPropagation();
                  setPageDraft(String(page + 1));
                }
              }}
              className="w-9 rounded border border-border-default bg-transparent px-1 py-0.5 text-center text-text-primary focus:border-accent/60 focus:outline-none"
            />
            <span>/ {pages ?? "…"}</span>
          </label>
          <Segment on={false} label="Next page" disabled={pages === null || page >= pages - 1} onClick={() => onPage(pdf.id, page + 1)}>
            ›
          </Segment>
        </>
      )}
      {elements.length > 0 && <ToolbarDivider />}
      {element && (
        <Segment on={false} label="Open fullscreen" onClick={() => onOpen(element)}>
          <ToolIcon path="M9.5 2.5h4v4 M13.5 2.5L9 7 M6.5 13.5h-4v-4 M2.5 13.5L7 9" />
        </Segment>
      )}
      <Segment on={false} label="Lock to background" onClick={onLock}>
        <ToolIcon path={LOCK_ICON} />
      </Segment>
      <Segment on={false} label="Delete (Del)" onClick={onDelete}>
        <ToolIcon path="M2.5 4.5h11 M6 4.5V3h4v1.5 M4 4.5l.7 9h6.6l.7-9 M6.8 7v4.5 M9.2 7v4.5" />
      </Segment>
    </div>
  );
}

/** A floating image, filling its box; a broken one says so. */
function ImageElement({ src }: { src: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <ElementPlaceholder>Could not load the image</ElementPlaceholder>;
  return <img src={src} alt="" draggable={false} onError={() => setFailed(true)} className="whiteboard-image block h-full w-full max-w-none select-none" />;
}

function ElementPlaceholder({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full w-full items-center justify-center border border-dashed border-border-strong bg-surface-raised p-2 text-center text-xs text-text-muted">
      {children}
    </div>
  );
}

/** A PDF open with pdf.js (shared, see `acquirePdf`), once it's loaded, or why it couldn't be. */
function usePdf(src: string | null): { doc: PDFDocumentProxy | null; error: string | null } {
  const [state, setState] = useState<{ src: string; doc: PDFDocumentProxy | null; error: string | null } | null>(null);
  useEffect(() => {
    if (!src) return;
    let cancelled = false;
    const { promise, release } = acquirePdf(src);
    promise.then(
      (doc) => !cancelled && setState({ src, doc, error: null }),
      (err) => !cancelled && setState({ src, doc: null, error: message(err) }),
    );
    return () => {
      cancelled = true;
      release();
    };
  }, [src]);
  return state && state.src === src ? state : { doc: null, error: null };
}

/**
 * A pinned PDF's page, filling its box: rendered at the resolution it's shown at (its width on screen, in device
 * pixels), so it stays sharp as the board zooms in; off screen, then copied over, so it doesn't flash blank. A zoom
 * renders it again once it rests; till then it's scaled as it was.
 */
function PdfPage({ src, page, width, zoom }: { src: string; page: number; width: number; zoom: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { doc, error } = usePdf(src);
  const [renderError, setRenderError] = useState<string | null>(null);
  const [rendered, setRendered] = useState(false);
  // In steps of 64 device pixels, so a small zoom or resize doesn't render it again.
  const pixels = Math.min(MAX_PDF_SIDE, Math.max(64, Math.ceil((width * zoom * (window.devicePixelRatio || 1)) / 64) * 64));

  useEffect(() => {
    const shown = canvasRef.current;
    if (!doc || !shown) return;
    let cancelled = false;
    let task: RenderTask | null = null;
    const key = `${src}#${page}`;
    const render = async () => {
      try {
        const pdfPage = await doc.getPage(Math.min(page, doc.numPages - 1) + 1);
        if (cancelled) return;
        const base = pdfPage.getViewport({ scale: 1 });
        const scale = Math.min(pixels / base.width, MAX_PDF_SIDE / base.height, Math.sqrt(MAX_CANVAS_AREA / (base.width * base.height)));
        const viewport = pdfPage.getViewport({ scale });
        const offscreen = document.createElement("canvas");
        offscreen.width = Math.max(1, Math.ceil(viewport.width));
        offscreen.height = Math.max(1, Math.ceil(viewport.height));
        task = pdfPage.render({ canvas: offscreen, viewport });
        await task.promise;
        if (cancelled) return;
        shown.width = offscreen.width;
        shown.height = offscreen.height;
        shown.getContext("2d")?.drawImage(offscreen, 0, 0);
        shown.dataset.page = key;
        setRendered(true);
        setRenderError(null);
      } catch (err) {
        if (!cancelled) setRenderError(message(err));
      }
    };
    // A page's first render isn't held back: there's nothing to show till it's done.
    const timer = setTimeout(() => void render(), shown.dataset.page === key ? PDF_RENDER_DELAY : 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      task?.cancel();
    };
  }, [doc, src, page, pixels]);

  const problem = error ?? renderError;
  if (problem) return <ElementPlaceholder>Could not show the PDF ({problem})</ElementPlaceholder>;
  return (
    <div className="relative h-full w-full bg-white">
      <canvas ref={canvasRef} className="block h-full w-full" />
      {!rendered && <div className="absolute inset-0 flex items-center justify-center text-xs text-neutral-500">Loading PDF…</div>}
    </div>
  );
}

/** A PDF page's size, in pixels at 100%. */
async function pdfPageSize(src: string, page: number): Promise<{ width: number; height: number }> {
  const { promise, release } = acquirePdf(src);
  try {
    const pdf = await promise;
    const { width, height } = (await pdf.getPage(Math.min(page, pdf.numPages - 1) + 1)).getViewport({ scale: PDF_SCALE });
    return { width, height };
  } finally {
    release();
  }
}

/** An image's natural size. */
function imageSize(src: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve({ width: image.naturalWidth || 320, height: image.naturalHeight || 240 });
    image.onerror = () => reject(new Error("the image could not be loaded"));
    image.src = src;
  });
}
