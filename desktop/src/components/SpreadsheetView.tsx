import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

import { Segment, ToolbarDivider, ToolIcon } from "./markupUi";
import {
  IMPORT_MAX_COLS,
  IMPORT_MAX_ROWS,
  SPREADSHEET_FILE_ACCEPT,
  awaitsReference,
  cellAddress,
  cellText,
  colLetter,
  createEvaluator,
  exportWorkbook,
  formatRangeAddress,
  formulaReferences,
  functionSuggestions,
  getEffectiveDisplayRange,
  parseRangeAddress,
  parseSpreadsheet,
  parseWorkbookBuffer,
  restyle,
  serializeSpreadsheet,
  setCell,
  sheetCols,
  shiftCells,
  type CellPos,
  type CellRange,
  type SpreadsheetData,
  type SpreadsheetStyle,
} from "./spreadsheet";

const ROW_H = 26;
const HEADER_H = 26;
const COL_W = 104;
const ROW_HEADER_W = 46;
/** Rows drawn beyond the visible ones, above and below, so scrolling doesn't show blanks. */
const OVERSCAN = 8;
/** Empty rows and columns shown past an editable sheet's cells, to type into. */
const SPARE_ROWS = 25;
const SPARE_COLS = 15;
const MIN_ROWS = 60;
const MIN_COLS = 26;
/** Columns beyond the window's width, so the grid always runs on past the screen's right edge. */
const OFFSCREEN_COLS = 5;
const UNDO_LIMIT = 100;

const ALIGN_ICONS: Record<NonNullable<SpreadsheetStyle["align"]>, string> = {
  left: "M2.5 4h11 M2.5 7h7 M2.5 10h11 M2.5 13h7",
  center: "M2.5 4h11 M4.5 7h7 M2.5 10h11 M4.5 13h7",
  right: "M2.5 4h11 M6.5 7h7 M2.5 10h11 M6.5 13h7",
};

type Edit = { row: number; col: number; text: string; where: "cell" | "bar" };
type Range = CellRange;
/** A cell reference being picked on the grid for a formula: where in its text it is, and the cell the drag began on. */
type Pick = { start: number; end: number; anchor: CellPos; dragging: boolean };

const rangeOf = (a: CellPos, b: CellPos): Range => ({
  r1: Math.min(a.row, b.row),
  c1: Math.min(a.col, b.col),
  r2: Math.max(a.row, b.row),
  c2: Math.max(a.col, b.col),
});

function addressesOf(range: Range): string[] {
  const addresses: string[] = [];
  for (let r = range.r1; r <= range.r2; r++) for (let c = range.c1; c <= range.c2; c++) addresses.push(cellAddress(r, c));
  return addresses;
}

const inside = (range: Range, r: number, c: number) => r >= range.r1 && r <= range.r2 && c >= range.c1 && c <= range.c2;

/** The border classes that outline `range` on cell (r, c): its sides that are the range's edges. */
function outlineEdges(range: Range, r: number, c: number): string {
  if (!inside(range, r, c)) return "";
  return [r === range.r1 && "border-t-2", r === range.r2 && "border-b-2", c === range.c1 && "border-l-2", c === range.c2 && "border-r-2"]
    .filter(Boolean)
    .join(" ");
}

/**
 * A spreadsheet (see spreadsheet.ts): its grid of cells, with formulas worked out. It shows one sheet, the saved
 * active one (a workbook imported with more keeps them, for the formulas that refer to them).
 *
 * In full (`compact` false) and `editable`, it has a toolbar (title, import and export, bold, italic and alignment,
 * rows and columns, the display area), a formula bar, and a grid, running on past the screen's edge, to type in:
 * arrows, Tab and Enter move, typing or Enter or F2 (or a double click) edits the cell, Escape cancels; Delete clears
 * the selection, Ctrl+B/I format it, Ctrl+C/X/V copy it as tab-separated text, Ctrl+Z/Y undo and redo. Typing a
 * formula offers its functions (arrows choose, Tab or Enter take one, Escape closes them), and where a cell reference
 * goes next, clicking a cell writes its address in, and dragging a range's. Each finished edit goes out through
 * `onChange`, as the whole spreadsheet's JSON.
 *
 * `compact` is the note's preview: the grid of the sheet's display area (or its cells in use), which only shows the
 * cells, with their column letters and row numbers if `editable`; a double click asks to open it in full
 * (`onExpand`) at that cell.
 */
export default function SpreadsheetView({
  value,
  onChange,
  editable,
  compact = false,
  initialCell,
  autoFocus = false,
  onEscape,
  onExpand,
  onSave,
  toolbarEnd,
  className = "",
}: {
  value: string;
  onChange?: (json: string) => void;
  editable: boolean;
  compact?: boolean;
  initialCell?: CellPos;
  autoFocus?: boolean;
  onEscape?: () => void;
  onExpand?: (cell?: CellPos) => void;
  onSave?: () => void;
  toolbarEnd?: ReactNode;
  className?: string;
}) {
  const data = useMemo(() => parseSpreadsheet(value), [value]);
  const evaluator = useMemo(() => createEvaluator(data), [data]);
  const canEdit = editable && !compact && !!onChange;

  const sheetIndex = Math.max(data.sheets.findIndex((s) => s.name === data.activeSheet), 0);
  const current = data.sheets[sheetIndex];
  const usedRows = current.rows.length;
  const usedCols = Math.max(sheetCols(current), 1);
  const screenCols = Math.ceil((typeof window !== "undefined" ? window.innerWidth : 1920) / COL_W) + OFFSCREEN_COLS;
  const rowCount = canEdit ? Math.max(usedRows + SPARE_ROWS, MIN_ROWS) : usedRows;
  const colCount = canEdit ? Math.max(usedCols + SPARE_COLS, MIN_COLS, screenCols) : usedCols;
  const displayArea = current.displayArea ? parseRangeAddress(current.displayArea) : null;
  // The cells drawn: in the note, its display area (cut to what a note could hold); in full, all of them.
  const bounds: Range = (() => {
    if (!compact) return { r1: 0, c1: 0, r2: rowCount - 1, c2: colCount - 1 };
    const area = getEffectiveDisplayRange(current);
    return { ...area, r2: Math.min(area.r2, area.r1 + IMPORT_MAX_ROWS - 1), c2: Math.min(area.c2, area.c1 + IMPORT_MAX_COLS - 1) };
  })();
  // A published note's spreadsheet is just its cells: no column letters or row numbers.
  const showHeaders = !compact || editable;
  const rowHeaderW = showHeaders ? ROW_HEADER_W : 0;
  const headerH = showHeaders ? HEADER_H : 0;

  const start = initialCell ?? { row: bounds.r1, col: bounds.c1 };
  const [anchor, setAnchor] = useState<CellPos>(start);
  const [focus, setFocus] = useState<CellPos>(start);
  const [edit, setEdit] = useState<Edit | null>(null);
  const editRef = useRef(edit);
  editRef.current = edit;
  // Where the caret is in the edit's text, the functions offered there, and a reference being picked on the grid.
  const [caret, setCaret] = useState(0);
  const [suggestIndex, setSuggestIndex] = useState(0);
  const [suggestOff, setSuggestOff] = useState(false);
  const [suggestAt, setSuggestAt] = useState<{ left: number; top: number } | null>(null);
  const pickRef = useRef<Pick | null>(null);
  // The caret to put in the edit's input once it's drawn, after its text was changed for it.
  const pendingCaret = useRef<number | null>(null);
  const [titleDraft, setTitleDraft] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [scroll, setScroll] = useState({ top: 0, height: 400 });
  const range = rangeOf(anchor, focus);

  const gridRef = useRef<HTMLDivElement>(null);
  const cellInputRef = useRef<HTMLInputElement>(null);
  const barInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const undoRef = useRef<{ past: string[]; future: string[] }>({ past: [], future: [] });
  // A drag selecting cells with the mouse.
  const draggingRef = useRef(false);

  useEffect(() => {
    if (autoFocus) gridRef.current?.focus({ preventScroll: true });
  }, [autoFocus]);

  useEffect(() => {
    const stop = () => {
      draggingRef.current = false;
      if (pickRef.current) pickRef.current.dragging = false;
    };
    window.addEventListener("mouseup", stop);
    return () => window.removeEventListener("mouseup", stop);
  }, []);

  // The grid's height, for which rows to draw.
  useLayoutEffect(() => {
    const grid = gridRef.current;
    if (!grid) return;
    const measure = () => setScroll((s) => ({ ...s, height: grid.clientHeight }));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(grid);
    return () => observer.disconnect();
  }, []);

  // The functions offered for the name typed at the caret of a formula.
  const suggestions = edit && !suggestOff ? functionSuggestions(edit.text, caret) : null;
  const suggesting = !!suggestions;

  // The edit's text changed for it (a function taken, a reference picked): its caret goes where it was meant to.
  useLayoutEffect(() => {
    const at = pendingCaret.current;
    const input = edit?.where === "bar" ? barInputRef.current : cellInputRef.current;
    if (at === null || !input) return;
    pendingCaret.current = null;
    input.setSelectionRange(at, at);
    setCaret(at);
  });

  // The functions offered drop down below the input they're typed in.
  useLayoutEffect(() => {
    const input = edit?.where === "bar" ? barInputRef.current : cellInputRef.current;
    const rect = suggesting ? input?.getBoundingClientRect() : undefined;
    setSuggestAt(rect ? { left: rect.left, top: rect.bottom + 2 } : null);
  }, [suggesting, edit?.where, edit?.row, edit?.col]);

  // A sheet imported in place of this one starts at its first cell.
  const sheetName = current.name;
  const firstRender = useRef(true);
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    setAnchor({ row: 0, col: 0 });
    setFocus({ row: 0, col: 0 });
    setEdit(null);
    gridRef.current?.scrollTo({ top: 0, left: 0 });
  }, [sheetName]);

  /** Save `next`, remembering what it replaces for undo. */
  function commit(next: SpreadsheetData) {
    if (!onChange) return;
    const json = serializeSpreadsheet(next);
    if (json === value) return;
    const undo = undoRef.current;
    undo.past = [...undo.past, value].slice(-UNDO_LIMIT);
    undo.future = [];
    onChange(json);
  }

  const withSheet = (change: (s: typeof current) => typeof current): SpreadsheetData => ({
    ...data,
    activeSheet: sheetName,
    sheets: data.sheets.map((s, i) => (i === sheetIndex ? change(s) : s)),
  });

  function undo(redo = false) {
    if (!onChange) return;
    const stack = undoRef.current;
    const from = redo ? stack.future : stack.past;
    const json = from.pop();
    if (json === undefined) return;
    (redo ? stack.past : stack.future).push(value);
    setEdit(null);
    onChange(json);
  }

  // --- Selection --------------------------------------------------------------

  function scrollIntoView(cell: CellPos) {
    const grid = gridRef.current;
    if (!grid) return;
    const top = (cell.row - bounds.r1) * ROW_H;
    const left = (cell.col - bounds.c1) * COL_W;
    const viewH = grid.clientHeight - headerH;
    const viewW = grid.clientWidth - rowHeaderW;
    if (top < grid.scrollTop) grid.scrollTop = top;
    else if (top + ROW_H > grid.scrollTop + viewH) grid.scrollTop = top + ROW_H - viewH;
    if (left < grid.scrollLeft) grid.scrollLeft = left;
    else if (left + COL_W > grid.scrollLeft + viewW) grid.scrollLeft = left + COL_W - viewW;
  }

  function select(cell: CellPos, extend = false) {
    const clamped = { row: Math.min(Math.max(cell.row, bounds.r1), bounds.r2), col: Math.min(Math.max(cell.col, bounds.c1), bounds.c2) };
    if (!extend) setAnchor(clamped);
    setFocus(clamped);
    scrollIntoView(clamped);
  }

  // --- Editing ----------------------------------------------------------------

  function startEdit(text?: string, where: Edit["where"] = "cell") {
    if (!canEdit) return;
    const startText = text ?? cellText(current, focus.row, focus.col);
    setAnchor(focus);
    setEdit({ row: focus.row, col: focus.col, text: startText, where });
    // The cell's input starts with the caret at its end; the formula bar's, where it was clicked.
    if (where === "cell") pendingCaret.current = startText.length;
    pickRef.current = null;
    setSuggestOff(false);
    setSuggestIndex(0);
  }

  const editInput = () => (editRef.current?.where === "bar" ? barInputRef.current : cellInputRef.current);

  /** The edit's text as typed, with the caret at `at`. */
  function typeEdit(text: string, at: number | null) {
    const edit = editRef.current;
    if (!edit) return;
    pickRef.current = null;
    setSuggestOff(false);
    setSuggestIndex(0);
    if (at !== null) setCaret(at);
    setEdit({ ...edit, text });
  }

  /** The edit's text with `start`–`end` replaced by `insert`, and the caret after it. */
  function spliceEdit(start: number, end: number, insert: string) {
    const edit = editRef.current;
    if (!edit) return;
    const next = { ...edit, text: edit.text.slice(0, start) + insert + edit.text.slice(end) };
    editRef.current = next;
    pendingCaret.current = start + insert.length;
    setEdit(next);
  }

  function acceptSuggestion(name: string) {
    if (!suggestions) return;
    spliceEdit(suggestions.start, caret, `${name}(`);
    pickRef.current = null;
    setSuggestIndex(0);
  }

  /**
   * A click on `cell` while a formula is edited: if a reference goes at the caret (or the caret is just after one
   * picked), write the cell's address there and start a drag that makes it a range. Whether it did.
   */
  function pickReference(cell: CellPos): boolean {
    const edit = editRef.current;
    const input = editInput();
    if (!edit || !input || !edit.text.startsWith("=")) return false;
    const from = input.selectionStart ?? edit.text.length;
    const to = input.selectionEnd ?? from;
    const pick = pickRef.current;
    let start: number;
    let end: number;
    if (pick && from === pick.end && to === pick.end) [start, end] = [pick.start, pick.end];
    else if (awaitsReference(edit.text, from)) [start, end] = [from, to];
    else return false;
    const address = cellAddress(cell.row, cell.col);
    spliceEdit(start, end, address);
    pickRef.current = { start, end: start + address.length, anchor: cell, dragging: true };
    return true;
  }

  /** The reference being picked stretched to a range, from where its drag began to `cell`. */
  function dragPick(cell: CellPos) {
    const pick = pickRef.current;
    if (!pick) return;
    const address = formatRangeAddress(pick.anchor.row, pick.anchor.col, cell.row, cell.col);
    spliceEdit(pick.start, pick.end, address);
    pick.end = pick.start + address.length;
  }

  /** End the edit, saving it unless `cancel`, then move the selection by `move` and give the grid the keys back. */
  function finishEdit(cancel = false, move?: { dr: number; dc: number }) {
    // Once only: the input's blur, as it goes, would finish it again.
    const edit = editRef.current;
    if (!edit) return;
    editRef.current = null;
    pickRef.current = null;
    if (!cancel && edit.text !== cellText(current, edit.row, edit.col)) {
      commit(withSheet((s) => setCell(s, edit.row, edit.col, edit.text)));
    }
    setEdit(null);
    if (move) select({ row: edit.row + move.dr, col: edit.col + move.dc });
    gridRef.current?.focus({ preventScroll: true });
  }

  function clearRange() {
    commit(
      withSheet((s) => {
        let next = s;
        for (let r = range.r1; r <= Math.min(range.r2, s.rows.length - 1); r++) {
          for (let c = range.c1; c <= range.c2; c++) if (cellText(next, r, c)) next = setCell(next, r, c, "");
        }
        return next;
      }),
    );
  }

  function rangeTsv(): string {
    const lines: string[] = [];
    for (let r = range.r1; r <= range.r2; r++) {
      const cells: string[] = [];
      for (let c = range.c1; c <= range.c2; c++) cells.push(cellText(current, r, c).replace(/[\t\n\r]+/g, " "));
      lines.push(cells.join("\t"));
    }
    return lines.join("\n");
  }

  function pasteTsv(text: string) {
    const lines = text.replace(/\r\n?/g, "\n").replace(/\n$/, "").split("\n");
    const grid = lines.map((line) => line.split("\t"));
    commit(
      withSheet((s) => {
        let next = s;
        grid.forEach((cells, dr) => cells.forEach((cell, dc) => (next = setCell(next, range.r1 + dr, range.c1 + dc, cell))));
        return next;
      }),
    );
    const width = Math.max(...grid.map((cells) => cells.length));
    setAnchor({ row: range.r1, col: range.c1 });
    setFocus({ row: range.r1 + grid.length - 1, col: range.c1 + width - 1 });
  }

  // --- Formatting, rows and columns ---------------------------------------------

  const focusStyle: SpreadsheetStyle = current.styles?.[cellAddress(focus.row, focus.col)] ?? {};

  function toggle(key: "bold" | "italic") {
    const addresses = addressesOf(range);
    const on = addresses.every((addr) => current.styles?.[addr]?.[key]);
    commit(withSheet((s) => restyle(s, addresses, (style) => ({ ...style, [key]: !on }))));
  }

  function align(to: NonNullable<SpreadsheetStyle["align"]>) {
    const addresses = addressesOf(range);
    const same = addresses.every((addr) => current.styles?.[addr]?.align === to);
    commit(withSheet((s) => restyle(s, addresses, (style) => ({ ...style, align: same ? undefined : to }))));
  }

  function insert(axis: "row" | "col") {
    const at = axis === "row" ? range.r2 + 1 : range.c2 + 1;
    // Only within the sheet's cells: inserting past its end changes nothing.
    if (axis === "row" ? at > usedRows : at > usedCols) {
      select(axis === "row" ? { row: at, col: focus.col } : { row: focus.row, col: at });
      return;
    }
    commit(shiftCells(data, sheetIndex, axis, at, 1));
    select(axis === "row" ? { row: at, col: focus.col } : { row: focus.row, col: at });
  }

  function remove(axis: "row" | "col") {
    const from = axis === "row" ? range.r1 : range.c1;
    const count = axis === "row" ? range.r2 - range.r1 + 1 : range.c2 - range.c1 + 1;
    commit(shiftCells(data, sheetIndex, axis, from, -count));
    select(axis === "row" ? { row: from, col: focus.col } : { row: focus.row, col: from });
  }

  // --- Display area -------------------------------------------------------------

  /** The note shows only `area` of the sheet (an address, `A1:D8`), or, without one, its cells in use. */
  function setDisplayArea(area?: string) {
    commit(withSheet(({ displayArea: _old, ...s }) => (area ? { ...s, displayArea: area } : s)));
  }

  // --- Import and export ----------------------------------------------------------

  async function importFile(file: File) {
    setNotice(null);
    try {
      const { data: imported, truncated } = await parseWorkbookBuffer(await file.arrayBuffer(), file.name.replace(/\.[^.]+$/, ""));
      commit(imported);
      if (truncated) setNotice(`${file.name} was bigger than a note can hold: only its first rows and columns were imported.`);
    } catch (err) {
      setNotice(`Could not import ${file.name} (${err instanceof Error ? err.message : String(err)}).`);
    }
  }

  async function exportAs(format: "xlsx" | "csv") {
    try {
      await exportWorkbook(data, undefined, format);
    } catch (err) {
      setNotice(`Could not export the spreadsheet (${err instanceof Error ? err.message : String(err)}).`);
    }
  }

  // --- Keys -----------------------------------------------------------------------

  function onGridKeyDown(event: KeyboardEvent) {
    if (event.target !== gridRef.current) return;
    const mod = event.ctrlKey || event.metaKey;
    const key = event.key;
    const moves: Record<string, [number, number]> = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
    let handled = true;
    if (moves[key]) {
      const [dr, dc] = moves[key];
      const jump = mod ? (dr ? (dr > 0 ? usedRows - 1 - focus.row : -focus.row) : dc > 0 ? usedCols - 1 - focus.col : -focus.col) : 0;
      select({ row: focus.row + (mod ? (dr ? jump : 0) : dr), col: focus.col + (mod ? (dc ? jump : 0) : dc) }, event.shiftKey);
    } else if (key === "Tab") {
      select({ row: focus.row, col: focus.col + (event.shiftKey ? -1 : 1) });
    } else if (key === "Enter" && compact) {
      onExpand?.(focus);
    } else if (key === "Enter" && !canEdit) {
      select({ row: focus.row + (event.shiftKey ? -1 : 1), col: focus.col });
    } else if ((key === "Enter" || key === "F2") && canEdit) {
      startEdit();
    } else if ((key === "Delete" || key === "Backspace") && canEdit) {
      clearRange();
    } else if (mod && key.toLowerCase() === "a") {
      setAnchor({ row: bounds.r1, col: bounds.c1 });
      setFocus({ row: Math.min(Math.max(usedRows - 1, 0), bounds.r2), col: Math.min(usedCols - 1, bounds.c2) });
    } else if (mod && key.toLowerCase() === "b" && canEdit) {
      toggle("bold");
    } else if (mod && key.toLowerCase() === "i" && canEdit) {
      toggle("italic");
    } else if (!mod && !event.altKey && key.length === 1 && canEdit) {
      startEdit(key);
    } else {
      handled = false;
    }
    if (handled) {
      event.preventDefault();
      event.stopPropagation();
    }
  }

  function onRootKeyDown(event: KeyboardEvent) {
    const mod = event.ctrlKey || event.metaKey;
    const key = event.key.toLowerCase();
    if (event.key === "Escape" && onEscape) {
      event.preventDefault();
      onEscape();
    } else if (mod && key === "s" && onSave) {
      event.preventDefault();
      onSave();
    } else if (mod && canEdit && event.target === gridRef.current && (key === "z" || key === "y")) {
      event.preventDefault();
      undo(key === "y" || event.shiftKey);
    }
  }

  // Inputs (the cell's, the formula bar's) keep their keys from the grid and the editor.
  function onEditKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    event.stopPropagation();
    if (suggestions) {
      const count = suggestions.matches.length;
      let handled = true;
      if (event.key === "ArrowDown") setSuggestIndex((i) => (i + 1) % count);
      else if (event.key === "ArrowUp") setSuggestIndex((i) => (i - 1 + count) % count);
      else if (event.key === "Enter" || event.key === "Tab") acceptSuggestion(suggestions.matches[Math.min(suggestIndex, count - 1)].name);
      else if (event.key === "Escape") setSuggestOff(true);
      else handled = false;
      if (handled) {
        event.preventDefault();
        return;
      }
    }
    if (event.key === "Enter") {
      event.preventDefault();
      finishEdit(false, { dr: event.shiftKey ? -1 : 1, dc: 0 });
    } else if (event.key === "Tab") {
      event.preventDefault();
      finishEdit(false, { dr: 0, dc: event.shiftKey ? -1 : 1 });
    } else if (event.key === "Escape") {
      event.preventDefault();
      finishEdit(true);
    }
  }

  // --- Drawing --------------------------------------------------------------------

  const firstRow = bounds.r1 + Math.max(Math.floor(scroll.top / ROW_H) - OVERSCAN, 0);
  const lastRow = Math.min(bounds.r1 + Math.ceil((scroll.top + scroll.height) / ROW_H) + OVERSCAN, bounds.r2);
  const cols = Array.from({ length: bounds.c2 - bounds.c1 + 1 }, (_, i) => bounds.c1 + i);
  const shownRows: number[] = [];
  for (let r = firstRow; r <= lastRow; r++) shownRows.push(r);

  const focusText = edit ? edit.text : cellText(current, focus.row, focus.col);
  const refRanges = edit
    ? formulaReferences(edit.text)
        .filter((ref) => ref.sheet === null || ref.sheet.toLowerCase() === sheetName.toLowerCase())
        .map((ref) => ref.range)
    : [];
  const title = data.title || "Spreadsheet";

  return (
    <div className={`flex min-h-0 flex-col bg-background ${className}`} onKeyDown={onRootKeyDown}>
      {!compact && (
        <>
          <div role="toolbar" aria-label="Spreadsheet tools" className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-border-default px-3 py-1.5">
            {canEdit ? (
              <input
                aria-label="Spreadsheet title"
                value={titleDraft ?? data.title ?? ""}
                placeholder="Spreadsheet"
                onChange={(e) => setTitleDraft(e.target.value)}
                onBlur={() => {
                  if (titleDraft !== null && titleDraft.trim() !== (data.title ?? "")) {
                    const t = titleDraft.trim();
                    const { title: _old, ...rest } = data;
                    commit(t ? { ...rest, title: t } : rest);
                  }
                  setTitleDraft(null);
                }}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === "Enter") e.currentTarget.blur();
                  if (e.key === "Escape") {
                    setTitleDraft(null);
                    gridRef.current?.focus();
                  }
                }}
                className="h-8 w-48 rounded border border-transparent bg-transparent px-2 text-[15px] font-medium text-text-primary outline-none hover:border-border-default focus:border-accent"
              />
            ) : (
              <span className="px-2 text-[15px] font-medium text-text-primary">{title}</span>
            )}
            <ToolbarDivider />
            {canEdit && (
              <>
                <Segment on={false} label="Import a workbook (.xlsx, .csv, …), replacing this spreadsheet" onClick={() => fileInputRef.current?.click()}>
                  <span className="text-[14px]">Import</span>
                </Segment>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept={SPREADSHEET_FILE_ACCEPT}
                  className="hidden"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    e.target.value = "";
                    if (file) void importFile(file);
                  }}
                />
              </>
            )}
            <Segment on={false} label="Export as an Excel workbook (.xlsx)" onClick={() => void exportAs("xlsx")}>
              <span className="text-[14px]">Export .xlsx</span>
            </Segment>
            <Segment on={false} label="Export this sheet as .csv" onClick={() => void exportAs("csv")}>
              <span className="text-[14px]">.csv</span>
            </Segment>
            {canEdit && (
              <>
                <ToolbarDivider />
                <Segment on={!!focusStyle.bold} label="Bold (Ctrl+B)" onClick={() => toggle("bold")}>
                  <span className="text-[15px] font-bold">B</span>
                </Segment>
                <Segment on={!!focusStyle.italic} label="Italic (Ctrl+I)" onClick={() => toggle("italic")}>
                  <span className="font-serif text-[15px] italic">I</span>
                </Segment>
                {(["left", "center", "right"] as const).map((to) => (
                  <Segment key={to} on={focusStyle.align === to} label={`Align ${to}`} onClick={() => align(to)}>
                    <ToolIcon path={ALIGN_ICONS[to]} />
                  </Segment>
                ))}
                <ToolbarDivider />
                <Segment on={false} label="Insert a row below" onClick={() => insert("row")}>
                  <span className="text-[14px]">+ Row</span>
                </Segment>
                <Segment on={false} label="Delete the selected rows" onClick={() => remove("row")}>
                  <span className="text-[14px]">− Row</span>
                </Segment>
                <Segment on={false} label="Insert a column to the right" onClick={() => insert("col")}>
                  <span className="text-[14px]">+ Column</span>
                </Segment>
                <Segment on={false} label="Delete the selected columns" onClick={() => remove("col")}>
                  <span className="text-[14px]">− Column</span>
                </Segment>
                <ToolbarDivider />
                <Segment
                  on={false}
                  label="Set the display area: the note shows only the selected cells"
                  onClick={() => setDisplayArea(formatRangeAddress(range.r1, range.c1, range.r2, range.c2))}
                >
                  <span className="text-[14px]">Set display area</span>
                </Segment>
                {current.displayArea && (
                  <span className="flex h-7 items-center gap-1 rounded bg-accent/[0.12] pl-2 pr-0.5 font-mono text-[13px] text-accent-soft">
                    Display: {current.displayArea}
                    <button
                      type="button"
                      title="Clear the display area: the note shows all the cells in use"
                      aria-label="Clear the display area"
                      onClick={() => setDisplayArea()}
                      className="flex h-6 w-6 items-center justify-center rounded text-text-muted hover:bg-surface-hover hover:text-text-primary"
                    >
                      ✕
                    </button>
                  </span>
                )}
              </>
            )}
            <span className="ml-auto flex items-center gap-1">{toolbarEnd}</span>
          </div>
          <div className="flex shrink-0 items-center gap-2 border-b border-border-default px-3 py-1">
            <span className="w-16 shrink-0 font-mono text-[13px] text-text-secondary">
              {range.r1 === range.r2 && range.c1 === range.c2
                ? cellAddress(focus.row, focus.col)
                : `${cellAddress(range.r1, range.c1)}:${cellAddress(range.r2, range.c2)}`}
            </span>
            <span aria-hidden className="font-serif text-[14px] italic text-text-muted">
              fx
            </span>
            <input
              ref={barInputRef}
              aria-label="Cell contents"
              readOnly={!canEdit}
              value={focusText}
              onFocus={() => {
                if (canEdit && !edit) startEdit(undefined, "bar");
              }}
              onChange={(e) => typeEdit(e.target.value, e.target.selectionStart)}
              onSelect={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
              onBlur={() => edit?.where === "bar" && finishEdit()}
              onKeyDown={onEditKeyDown}
              className="h-7 min-w-0 flex-1 rounded border border-border-default bg-transparent px-2 font-mono text-[13px] text-text-primary outline-none focus:border-accent"
            />
          </div>
        </>
      )}
      {suggestions && suggestAt && (
        <ul
          role="listbox"
          aria-label="Functions"
          className="fixed z-50 w-80 overflow-hidden rounded-md border border-border-default bg-surface-raised py-1 shadow-lg"
          style={{ left: suggestAt.left, top: suggestAt.top }}
        >
          {suggestions.matches.map((f, i) => (
            <li
              key={f.name}
              role="option"
              aria-selected={i === suggestIndex}
              onMouseDown={(e) => {
                // The edit's input keeps the focus.
                e.preventDefault();
                acceptSuggestion(f.name);
              }}
              onMouseEnter={() => setSuggestIndex(i)}
              className={`cursor-pointer px-3 py-1.5 ${i === suggestIndex ? "bg-accent/[0.16]" : ""}`}
            >
              <div className="font-mono text-[13px] text-text-primary">{f.syntax}</div>
              <div className="text-[12px] text-text-muted">{f.description}</div>
            </li>
          ))}
        </ul>
      )}
      {notice && (
        <p role="alert" className="flex shrink-0 items-center gap-2 border-b border-border-default px-3 py-1 text-[14px] text-accent">
          {notice}
          <button type="button" className="ml-auto text-xs text-text-muted hover:text-text-primary" onClick={() => setNotice(null)}>
            Dismiss
          </button>
        </p>
      )}
      <div
        ref={gridRef}
        role="grid"
        aria-label={`${title}: ${sheetName}`}
        aria-rowcount={rowCount}
        aria-colcount={colCount}
        tabIndex={0}
        onKeyDown={onGridKeyDown}
        onScroll={(e) => {
          const top = e.currentTarget.scrollTop;
          setScroll((s) => (Math.abs(s.top - top) >= ROW_H / 2 ? { ...s, top } : s));
        }}
        onCopy={(e) => {
          if (e.target !== gridRef.current) return;
          e.preventDefault();
          e.clipboardData.setData("text/plain", rangeTsv());
        }}
        onCut={(e) => {
          if (e.target !== gridRef.current || !canEdit) return;
          e.preventDefault();
          e.clipboardData.setData("text/plain", rangeTsv());
          clearRange();
        }}
        onPaste={(e) => {
          if (e.target !== gridRef.current || !canEdit) return;
          e.preventDefault();
          const text = e.clipboardData.getData("text/plain");
          if (text) pasteTsv(text);
        }}
        className={`spreadsheet-grid relative overflow-auto outline-none ${compact ? "max-h-[480px]" : "min-h-0 flex-1"}`}
      >
        <table className="border-separate border-spacing-0 text-[13px]" style={{ tableLayout: "fixed", width: rowHeaderW + cols.length * COL_W }}>
          <colgroup>
            {showHeaders && <col style={{ width: ROW_HEADER_W }} />}
            {cols.map((c) => (
              <col key={c} style={{ width: COL_W }} />
            ))}
          </colgroup>
          {showHeaders && (
            <thead>
              <tr style={{ height: HEADER_H }}>
                <th className="sticky left-0 top-0 z-30 border-b border-r border-border-default" />
                {cols.map((c) => (
                  <th
                    key={c}
                    scope="col"
                    onMouseDown={(e) => {
                      e.preventDefault();
                      gridRef.current?.focus({ preventScroll: true });
                      setAnchor({ row: bounds.r1, col: e.shiftKey ? anchor.col : c });
                      setFocus({ row: bounds.r2, col: c });
                    }}
                    data-active={c >= range.c1 && c <= range.c2 ? "" : undefined}
                    className="sticky top-0 z-20 cursor-default select-none border-b border-r border-border-default"
                  >
                    {colLetter(c)}
                  </th>
                ))}
              </tr>
            </thead>
          )}
          <tbody>
            {firstRow > bounds.r1 && <tr aria-hidden style={{ height: (firstRow - bounds.r1) * ROW_H }} />}
            {shownRows.map((r) => (
              <tr key={r} style={{ height: ROW_H }}>
                {showHeaders && (
                  <th
                    scope="row"
                    onMouseDown={(e) => {
                      e.preventDefault();
                      gridRef.current?.focus({ preventScroll: true });
                      setAnchor({ row: e.shiftKey ? anchor.row : r, col: bounds.c1 });
                      setFocus({ row: r, col: bounds.c2 });
                    }}
                    data-active={r >= range.r1 && r <= range.r2 ? "" : undefined}
                    className="sticky left-0 z-10 cursor-default select-none border-b border-r border-border-default text-center"
                  >
                    {r + 1}
                  </th>
                )}
                {cols.map((c) => {
                  const inRange = r >= range.r1 && r <= range.r2 && c >= range.c1 && c <= range.c2;
                  const isFocus = r === focus.row && c === focus.col;
                  const editing = edit?.where === "cell" && edit.row === r && edit.col === c;
                  const style = current.styles?.[cellAddress(r, c)];
                  const kind = evaluator.kind(sheetIndex, r, c);
                  const shown = evaluator.display(sheetIndex, r, c);
                  // The display area's outline, in full view, and the cells the formula being typed refers to.
                  const displayEdges = !compact && displayArea ? outlineEdges(displayArea, r, c) : "";
                  const refEdges = refRanges.map((ref) => outlineEdges(ref, r, c)).filter(Boolean);
                  const textAlign = style?.align ?? (kind === "number" ? "right" : kind === "error" ? "center" : "left");
                  return (
                    <td
                      key={c}
                      onMouseDown={(e) => {
                        if (editing) return;
                        e.preventDefault();
                        // While a formula's edited, the click may write a reference into it, the edit going on.
                        if (canEdit && !e.shiftKey && pickReference({ row: r, col: c })) return;
                        // An edit elsewhere is finished by its input's blur.
                        gridRef.current?.focus({ preventScroll: true });
                        draggingRef.current = true;
                        select({ row: r, col: c }, e.shiftKey);
                      }}
                      onMouseEnter={(e) => {
                        if (e.buttons !== 1) return;
                        if (pickRef.current?.dragging) dragPick({ row: r, col: c });
                        else if (draggingRef.current) setFocus({ row: r, col: c });
                      }}
                      onDoubleClick={() => {
                        if (compact) onExpand?.({ row: r, col: c });
                        else startEdit();
                      }}
                      title={shown.length > 14 ? shown : undefined}
                      className={`relative overflow-hidden whitespace-nowrap border-b border-r border-border-default/60 px-1.5 ${
                        inRange && !isFocus ? "bg-accent/[0.08]" : ""
                      } ${kind === "error" ? "text-accent" : "text-text-primary"}`}
                      style={{
                        textAlign,
                        fontWeight: style?.bold ? 600 : undefined,
                        fontStyle: style?.italic ? "italic" : undefined,
                        backgroundColor: style?.bg && !inRange ? style.bg : undefined,
                        color: style?.color,
                        textOverflow: "ellipsis",
                      }}
                    >
                      {editing ? (
                        <input
                          ref={cellInputRef}
                          autoFocus
                          aria-label={`Cell ${cellAddress(r, c)}`}
                          value={edit.text}
                          onChange={(e) => typeEdit(e.target.value, e.target.selectionStart)}
                          onSelect={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
                          onBlur={() => finishEdit()}
                          onKeyDown={onEditKeyDown}
                          className="absolute inset-0 z-10 h-full w-full border-2 border-accent bg-background px-1 text-[13px] text-text-primary outline-none"
                          style={{ minWidth: COL_W * 2 }}
                        />
                      ) : (
                        shown
                      )}
                      {isFocus && !editing && <span aria-hidden className="pointer-events-none absolute inset-0 border-2 border-accent" />}
                      {displayEdges && <span aria-hidden className={`pointer-events-none absolute inset-0 border-dashed border-text-muted ${displayEdges}`} />}
                      {refEdges.map((edges, i) => (
                        <span key={i} aria-hidden className={`pointer-events-none absolute inset-0 z-[5] border-dashed border-accent-soft ${edges}`} />
                      ))}
                    </td>
                  );
                })}
              </tr>
            ))}
            {lastRow < bounds.r2 && <tr aria-hidden style={{ height: (bounds.r2 - lastRow) * ROW_H }} />}
          </tbody>
        </table>
      </div>
    </div>
  );
}
