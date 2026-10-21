/**
 * The spreadsheet embedded in a note (see SpreadsheetWidget): its data, the formulas its cells may hold, and reading
 * and writing Excel workbooks.
 *
 * A spreadsheet is saved in the note as a ```spreadsheet fenced block of its JSON, on one line (see noteFormatting):
 *
 *   {"title":"Budget","activeSheet":"Costs","sheets":[{"name":"Costs","rows":[["Item","Qty"],["Keel bolts","12"]],
 *    "styles":{"A1":{"bold":true}}}]}
 *
 * Every cell is text, as typed: a number is its digits, and a formula starts with `=` (`=SUM(B2:B9)`, `=B2*C2`,
 * `=Costs!D4`). Formulas are worked out when the sheet is shown (`createEvaluator`), never saved. A sheet's
 * `displayArea` (`A1:D8`) is the cells its note shows, like Excel's print area.
 *
 * Formulas know `+ - * / ^`, parentheses, cells (`B2`, `$B$2`), ranges (`B2:B9`), other sheets (`Costs!B2`,
 * `'Hull data'!A1:A5`), and SUM, AVERAGE, COUNT, MIN, MAX, ROUND, ABS. Anything else shows an Excel-style error
 * (`#NAME?`, `#REF!`, `#DIV/0!`, `#VALUE!`, `#CYCLE!`).
 *
 * The `xlsx` package, which reads and writes workbooks, is loaded only when one is imported or exported.
 */

import { EMPTY_SPREADSHEET_JSON } from "./noteFormatting";

export { EMPTY_SPREADSHEET_JSON };

export type SpreadsheetStyle = {
  bold?: boolean;
  italic?: boolean;
  align?: "left" | "center" | "right";
  bg?: string;
  color?: string;
};

export type SpreadsheetSheet = {
  name: string;
  /** Row by row, each cell's text as typed (a formula with its `=`). Rows may be ragged; missing cells are empty. */
  rows: string[][];
  /** By cell address (`B2`). */
  styles?: Record<string, SpreadsheetStyle>;
  /** The cells the note shows (`A1:D8`), like Excel's print area; without it, the note shows the cells in use. */
  displayArea?: string;
};

export type SpreadsheetData = { activeSheet: string; sheets: SpreadsheetSheet[]; title?: string };

/** A cell's place: 0-based row and column. */
export type CellPos = { row: number; col: number };

/** A block of cells, 0-based and inclusive: rows `r1`–`r2`, columns `c1`–`c2`. */
export type CellRange = { r1: number; c1: number; r2: number; c2: number };

/** The size a new sheet starts at. */
export const NEW_SHEET_ROWS = 5;
export const NEW_SHEET_COLS = 5;
/** What an imported workbook is cut to, so its note stays a size the editor handles. */
export const IMPORT_MAX_ROWS = 2000;
export const IMPORT_MAX_COLS = 52;
/** File types the spreadsheet imports, and the note takes in as spreadsheets when dropped or pasted. */
export const SPREADSHEET_FILE_ACCEPT = ".xlsx,.xlsm,.xls,.ods,.csv,.tsv";
const SPREADSHEET_FILE = /\.(xlsx|xlsm|xls|ods|csv|tsv)$/i;

export function isSpreadsheetFile(file: File): boolean {
  return SPREADSHEET_FILE.test(file.name);
}

// --- Addresses ------------------------------------------------------------------

/** A 0-based column's letters: 0 → A, 25 → Z, 26 → AA. */
export function colLetter(index: number): string {
  let letters = "";
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) letters = String.fromCharCode(65 + ((n - 1) % 26)) + letters;
  return letters;
}

/** A cell's address: (0, 0) → A1. */
export function cellAddress(row: number, col: number): string {
  return `${colLetter(col)}${row + 1}`;
}

/** The cell an address names (`B2`, `$B$2`, any case), or null if it isn't one. */
export function parseCellAddress(addr: string): CellPos | null {
  const match = /^\$?([A-Za-z]{1,3})\$?(\d{1,7})$/.exec(addr.trim());
  if (!match) return null;
  let col = 0;
  for (const ch of match[1].toUpperCase()) col = col * 26 + (ch.charCodeAt(0) - 64);
  const row = Number(match[2]);
  return row >= 1 ? { row: row - 1, col: col - 1 } : null;
}

/** The cells a range's address names (`B2:D8`, either corner first, or a single cell `B2`), or null. */
export function parseRangeAddress(range: string): CellRange | null {
  const [from, to, ...rest] = range.split(":");
  if (rest.length) return null;
  const a = parseCellAddress(from);
  const b = to === undefined ? a : parseCellAddress(to);
  if (!a || !b) return null;
  return { r1: Math.min(a.row, b.row), c1: Math.min(a.col, b.col), r2: Math.max(a.row, b.row), c2: Math.max(a.col, b.col) };
}

/** A range's address: (0, 0, 7, 3) → A1:D8, and a single cell's just its own (A1). */
export function formatRangeAddress(r1: number, c1: number, r2: number, c2: number): string {
  const from = cellAddress(Math.min(r1, r2), Math.min(c1, c2));
  const to = cellAddress(Math.max(r1, r2), Math.max(c1, c2));
  return from === to ? from : `${from}:${to}`;
}

// --- Data -----------------------------------------------------------------------

export function emptyRows(rows = NEW_SHEET_ROWS, cols = NEW_SHEET_COLS): string[][] {
  return Array.from({ length: rows }, () => Array<string>(cols).fill(""));
}

/** A spreadsheet from its saved JSON, made whole: at least one sheet, every cell text, and a sheet that's active. */
export function parseSpreadsheet(json: string): SpreadsheetData {
  let raw: unknown;
  try {
    raw = JSON.parse(json || EMPTY_SPREADSHEET_JSON);
  } catch {
    raw = null;
  }
  const obj = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const sheets: SpreadsheetSheet[] = [];
  for (const item of Array.isArray(obj.sheets) ? obj.sheets : []) {
    if (!item || typeof item !== "object") continue;
    const sheet = item as Record<string, unknown>;
    const rows = Array.isArray(sheet.rows)
      ? sheet.rows.map((row) => (Array.isArray(row) ? row.map((v) => (v == null ? "" : String(v))) : []))
      : [];
    const name = typeof sheet.name === "string" && sheet.name.trim() ? sheet.name : `Sheet${sheets.length + 1}`;
    const styles = sheet.styles && typeof sheet.styles === "object" ? (sheet.styles as Record<string, SpreadsheetStyle>) : undefined;
    const displayArea = typeof sheet.displayArea === "string" && parseRangeAddress(sheet.displayArea) ? sheet.displayArea : undefined;
    sheets.push({
      name: uniqueSheetName(sheets, name),
      rows: rows.length ? rows : emptyRows(),
      ...(styles ? { styles } : {}),
      ...(displayArea ? { displayArea } : {}),
    });
  }
  if (!sheets.length) sheets.push({ name: "Sheet1", rows: emptyRows() });
  const active = typeof obj.activeSheet === "string" && sheets.some((s) => s.name === obj.activeSheet) ? obj.activeSheet : sheets[0].name;
  const title = typeof obj.title === "string" && obj.title.trim() ? obj.title : undefined;
  return { activeSheet: active, sheets, ...(title ? { title } : {}) };
}

export function serializeSpreadsheet(data: SpreadsheetData): string {
  return JSON.stringify(data);
}

/** `name`, or `name 2`, `name 3`, … if a sheet in `sheets` has it already (ignoring case). */
export function uniqueSheetName(sheets: SpreadsheetSheet[], name: string): string {
  const taken = new Set(sheets.map((s) => s.name.toLowerCase()));
  let candidate = name;
  for (let n = 2; taken.has(candidate.toLowerCase()); n++) candidate = `${name} ${n}`;
  return candidate;
}

/** The sheet's width: its widest row. */
export function sheetCols(sheet: SpreadsheetSheet): number {
  return sheet.rows.reduce((w, row) => Math.max(w, row.length), 0);
}

/**
 * The cells the note shows of `sheet`: its display area if it has one, else from A1 to its last row and column
 * with anything in them (all of it, if it's empty).
 */
export function getEffectiveDisplayRange(sheet: SpreadsheetSheet): CellRange {
  const area = sheet.displayArea ? parseRangeAddress(sheet.displayArea) : null;
  if (area) return area;
  let r2 = -1;
  let c2 = -1;
  sheet.rows.forEach((row, r) =>
    row.forEach((text, c) => {
      if (!text.trim()) return;
      r2 = Math.max(r2, r);
      c2 = Math.max(c2, c);
    }),
  );
  if (r2 < 0) return { r1: 0, c1: 0, r2: Math.max(sheet.rows.length - 1, 0), c2: Math.max(sheetCols(sheet) - 1, 0) };
  return { r1: 0, c1: 0, r2, c2 };
}

export function cellText(sheet: SpreadsheetSheet, row: number, col: number): string {
  return sheet.rows[row]?.[col] ?? "";
}

/** `sheet` with `text` in the cell, growing it to reach the cell. */
export function setCell(sheet: SpreadsheetSheet, row: number, col: number, text: string): SpreadsheetSheet {
  const rows = sheet.rows.slice();
  while (rows.length <= row) rows.push([]);
  const cells = rows[row].slice();
  while (cells.length <= col) cells.push("");
  cells[col] = text;
  rows[row] = cells;
  return { ...sheet, rows };
}

/** `sheet` with each style in `addresses` changed by `change` (its result replacing it; empty ones are dropped). */
export function restyle(
  sheet: SpreadsheetSheet,
  addresses: string[],
  change: (style: SpreadsheetStyle) => SpreadsheetStyle,
): SpreadsheetSheet {
  const styles = { ...(sheet.styles ?? {}) };
  for (const addr of addresses) {
    const next = change(styles[addr] ?? {});
    const kept = Object.fromEntries(Object.entries(next).filter(([, v]) => v !== undefined && v !== false && v !== ""));
    if (Object.keys(kept).length) styles[addr] = kept as SpreadsheetStyle;
    else delete styles[addr];
  }
  return { ...sheet, styles };
}

/**
 * The spreadsheet with `count` rows (or columns) inserted before index `at` of sheet `sheetIndex` (a negative
 * `count` deletes them instead), its styles moved along, and every formula's references to that sheet changed to
 * match: a reference into deleted cells becomes `#REF!`.
 */
type Edge = "cell" | "start" | "end";

export function shiftCells(data: SpreadsheetData, sheetIndex: number, axis: "row" | "col", at: number, count: number): SpreadsheetData {
  const target = data.sheets[sheetIndex];
  // A deleted cell is gone (null), unless it's the start or end of a range, which shrinks to the cells left.
  const shiftIndex = (i: number, edge: Edge = "cell"): number | null => {
    if (i < at) return i;
    if (count < 0 && i < at - count) return edge === "start" ? at : edge === "end" ? at - 1 : null;
    return i + count;
  };
  const sheets = data.sheets.map((sheet, index) => {
    const rows = sheet.rows.map((row) =>
      row.map((text) => (text.startsWith("=") ? shiftFormula(text, target.name, index === sheetIndex, axis, shiftIndex) : text)),
    );
    if (index !== sheetIndex) return { ...sheet, rows };
    let shifted: string[][];
    if (axis === "row") {
      shifted = rows.slice();
      if (count > 0) shifted.splice(at, 0, ...emptyRows(count, Math.max(sheetCols(sheet), 1)));
      else shifted.splice(at, -count);
      if (!shifted.length) shifted.push([""]);
    } else {
      shifted = rows.map((row) => {
        const cells = row.slice();
        if (count > 0) {
          if (cells.length >= at) cells.splice(at, 0, ...Array<string>(count).fill(""));
        } else cells.splice(at, -count);
        return cells;
      });
      if (shifted.every((row) => !row.length)) shifted = shifted.map(() => [""]);
    }
    const styles: Record<string, SpreadsheetStyle> = {};
    for (const [addr, style] of Object.entries(sheet.styles ?? {})) {
      const pos = parseCellAddress(addr);
      if (!pos) continue;
      const moved = shiftIndex(axis === "row" ? pos.row : pos.col);
      if (moved === null) continue;
      styles[axis === "row" ? cellAddress(moved, pos.col) : cellAddress(pos.row, moved)] = style;
    }
    return { ...sheet, rows: shifted, styles };
  });
  return { ...data, sheets };
}

// --- Formulas -------------------------------------------------------------------

type Token =
  | { kind: "num"; value: number; start: number; end: number }
  | { kind: "str"; value: string; start: number; end: number }
  | { kind: "ref"; sheet: string | null; from: string; to: string | null; start: number; end: number }
  | { kind: "name"; value: string; start: number; end: number }
  | { kind: "op"; value: string; start: number; end: number }
  | { kind: "error"; value: string; start: number; end: number };

const SHEET_PREFIX = String.raw`(?:'((?:[^']|'')+)'|([A-Za-z_][\w.]*))!`;
const CELL = String.raw`\$?[A-Za-z]{1,3}\$?\d{1,7}`;
const REF = new RegExp(String.raw`^(?:${SHEET_PREFIX})?(${CELL})(?::(${CELL}))?(?![\w(])`);

/** A formula's tokens (without its `=`): numbers, strings, cell references and ranges, names, operators. */
function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    const rest = src.slice(i);
    const num = /^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?%?/i.exec(rest);
    if (num) {
      const text = num[0];
      const value = Number(text.replace("%", "")) / (text.endsWith("%") ? 100 : 1);
      tokens.push({ kind: "num", value, start: i, end: i + text.length });
      i += text.length;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let value = "";
      while (j < src.length) {
        if (src[j] === '"' && src[j + 1] === '"') {
          value += '"';
          j += 2;
        } else if (src[j] === '"') break;
        else value += src[j++];
      }
      tokens.push({ kind: "str", value, start: i, end: j + 1 });
      i = j + 1;
      continue;
    }
    const ref = REF.exec(rest);
    if (ref) {
      const sheet = ref[1] !== undefined ? ref[1].replace(/''/g, "'") : (ref[2] ?? null);
      tokens.push({ kind: "ref", sheet, from: ref[3], to: ref[4] ?? null, start: i, end: i + ref[0].length });
      i += ref[0].length;
      continue;
    }
    const error = /^#(REF!|DIV\/0!|VALUE!|NAME\?|N\/A|CYCLE!)/.exec(rest);
    if (error) {
      tokens.push({ kind: "error", value: error[0], start: i, end: i + error[0].length });
      i += error[0].length;
      continue;
    }
    const name = /^[A-Za-z_][\w.]*/.exec(rest);
    if (name) {
      tokens.push({ kind: "name", value: name[0].toUpperCase(), start: i, end: i + name[0].length });
      i += name[0].length;
      continue;
    }
    const op = /^(<>|<=|>=|[-+*/^(),:&=<>])/.exec(rest);
    tokens.push({ kind: "op", value: op ? op[0] : ch, start: i, end: i + (op ? op[0].length : 1) });
    i += op ? op[0].length : 1;
  }
  return tokens;
}

/** The cells a formula (with its `=`) refers to, each as the sheet named (null for its own) and the cells. */
export function formulaReferences(formula: string): { sheet: string | null; range: CellRange }[] {
  if (!formula.startsWith("=")) return [];
  const refs: { sheet: string | null; range: CellRange }[] = [];
  for (const token of tokenize(formula.slice(1))) {
    if (token.kind !== "ref") continue;
    const range = parseRangeAddress(token.to ? `${token.from}:${token.to}` : token.from);
    if (range) refs.push({ sheet: token.sheet, range });
  }
  return refs;
}

/** A sheet name as a formula writes it: quoted unless it's a plain word. */
export function quoteSheetName(name: string): string {
  return /^[A-Za-z_][\w.]*$/.test(name) && !parseCellAddress(name) ? name : `'${name.replace(/'/g, "''")}'`;
}

/** `formula` (in a sheet that is `inTarget` or not) with its references to sheet `target` moved by `shift`. */
function shiftFormula(
  formula: string,
  target: string,
  inTarget: boolean,
  axis: "row" | "col",
  shift: (i: number, edge?: Edge) => number | null,
): string {
  const body = formula.slice(1);
  let out = "";
  let last = 0;
  for (const token of tokenize(body)) {
    if (token.kind !== "ref") continue;
    const pointsAtTarget = token.sheet === null ? inTarget : token.sheet.toLowerCase() === target.toLowerCase();
    if (!pointsAtTarget) continue;
    const index = (addr: string) => {
      const pos = parseCellAddress(addr)!;
      return axis === "row" ? pos.row : pos.col;
    };
    const move = (addr: string, moved: number | null): string | null => {
      if (moved === null) return null;
      const match = /^(\$?)([A-Za-z]{1,3})(\$?)(\d{1,7})$/.exec(addr)!;
      return axis === "row"
        ? `${match[1]}${match[2]}${match[3]}${moved + 1}`
        : `${match[1]}${colLetter(moved)}${match[3]}${match[4]}`;
    };
    const prefix = token.sheet === null ? "" : `${quoteSheetName(token.sheet)}!`;
    let replaced: string;
    if (!token.to) {
      const from = move(token.from, shift(index(token.from)));
      replaced = from === null ? "#REF!" : `${prefix}${from}`;
    } else {
      const forward = index(token.from) <= index(token.to);
      const a = shift(index(token.from), forward ? "start" : "end");
      const b = shift(index(token.to), forward ? "end" : "start");
      // The whole range deleted: nothing's left of it.
      const gone = a === null || b === null || (forward ? a > b : b > a);
      replaced = gone ? "#REF!" : `${prefix}${move(token.from, a)}:${move(token.to, b)}`;
    }
    out += body.slice(last, token.start) + replaced;
    last = token.end;
  }
  return "=" + out + body.slice(last);
}

/** The spreadsheet with sheet `index` named `name`, and every formula's references to it (`Old!A1`) renamed too. */
export function renameSheet(data: SpreadsheetData, index: number, name: string): SpreadsheetData {
  const old = data.sheets[index].name;
  const rename = (formula: string): string => {
    const body = formula.slice(1);
    let out = "";
    let last = 0;
    for (const token of tokenize(body)) {
      if (token.kind !== "ref" || token.sheet === null || token.sheet.toLowerCase() !== old.toLowerCase()) continue;
      out += body.slice(last, token.start) + `${quoteSheetName(name)}!${token.from}${token.to ? `:${token.to}` : ""}`;
      last = token.end;
    }
    return "=" + out + body.slice(last);
  };
  const sheets = data.sheets.map((sheet, i) => ({
    ...sheet,
    name: i === index ? name : sheet.name,
    rows: sheet.rows.map((row) => row.map((text) => (text.startsWith("=") ? rename(text) : text))),
  }));
  return { ...data, sheets, activeSheet: data.activeSheet === old ? name : data.activeSheet };
}

/** A worked-out value: a number, text, or an error (`#REF!`, …). */
type Value = number | string | { error: string };
const err = (error: string): Value => ({ error });
const isError = (v: Value): v is { error: string } => typeof v === "object";

class FormulaError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

/** A typed cell's number, or null if it holds none: `12`, `-3.5`, `1,200`, `15%`. */
export function cellNumber(text: string): number | null {
  const trimmed = text.trim();
  if (!trimmed || !/^[-+]?(\d[\d,]*\.?\d*|\.\d+)(e[+-]?\d+)?%?$/i.test(trimmed)) return null;
  const value = Number(trimmed.replace(/,/g, "").replace("%", ""));
  if (!Number.isFinite(value)) return null;
  return trimmed.endsWith("%") ? value / 100 : value;
}

/** A value as a cell shows it: numbers to 12 significant digits, without float noise. */
export function formatValue(value: Value): string {
  if (isError(value)) return value.error;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return "#NUM!";
    return String(Number(value.toPrecision(12)));
  }
  return value;
}

export type FormulaFunctionInfo = {
  name: string;
  syntax: string;
  description: string;
};

/** The functions formulas know, as the formula autocomplete offers them. */
export const FORMULA_FUNCTIONS: FormulaFunctionInfo[] = [
  { name: "SUM", syntax: "SUM(number1, [number2], ...)", description: "Adds all numbers in a range." },
  { name: "AVERAGE", syntax: "AVERAGE(number1, [number2], ...)", description: "Calculates the arithmetic mean of numbers in a range." },
  { name: "COUNT", syntax: "COUNT(value1, [value2], ...)", description: "Counts cells that contain numbers." },
  { name: "MIN", syntax: "MIN(number1, [number2], ...)", description: "Returns the smallest number in a range." },
  { name: "MAX", syntax: "MAX(number1, [number2], ...)", description: "Returns the largest number in a range." },
  { name: "ROUND", syntax: "ROUND(number, num_digits)", description: "Rounds a number to a specified number of digits." },
  { name: "ABS", syntax: "ABS(number)", description: "Returns the absolute value of a number." },
];

/**
 * The function name being typed at `caret` in a formula (`=SU|`, `=B2+av|`): where it starts, and the functions it
 * could be. None if the text there isn't a formula's function name.
 */
export function functionSuggestions(text: string, caret: number): { start: number; matches: FormulaFunctionInfo[] } | null {
  if (!text.startsWith("=")) return null;
  const before = text.slice(0, caret);
  const match = /[A-Za-z]+$/.exec(before);
  if (!match || !/[=(,+\-*/^&<> ]/.test(before[match.index - 1] ?? "")) return null;
  // Not if it's the start of a word that goes on past the caret (`=SU|M`).
  if (/^[\w(]/.test(text.slice(caret))) return null;
  const prefix = match[0].toUpperCase();
  const matches = FORMULA_FUNCTIONS.filter((f) => f.name.startsWith(prefix));
  return matches.length ? { start: match.index, matches } : null;
}

/** Whether a formula's caret is where a cell reference goes next: after `=`, `(`, `,` or an operator. */
export function awaitsReference(text: string, caret: number): boolean {
  return text.startsWith("=") && /[=(,+\-*/^&<>:]\s*$/.test(text.slice(0, caret));
}

type Evaluator = {
  /** The value a cell shows: its text, or its formula's result. */
  display: (sheetIndex: number, row: number, col: number) => string;
  /** Whether that value is a number (shown right-aligned) or an error. */
  kind: (sheetIndex: number, row: number, col: number) => "number" | "text" | "error";
};

/**
 * Works out the cells of `data`, each once (results are cached, so make a new evaluator when the data changes).
 * A formula that ends up depending on itself shows `#CYCLE!`.
 */
export function createEvaluator(data: SpreadsheetData): Evaluator {
  const cache = new Map<string, Value>();
  const visiting = new Set<string>();
  const sheetIndexByName = new Map(data.sheets.map((s, i) => [s.name.toLowerCase(), i]));

  function cellValue(sheetIndex: number, row: number, col: number): Value {
    const key = `${sheetIndex}:${row}:${col}`;
    const cached = cache.get(key);
    if (cached !== undefined) return cached;
    const text = cellText(data.sheets[sheetIndex], row, col);
    let value: Value;
    if (text.startsWith("=") && text.length > 1) {
      if (visiting.has(key)) return err("#CYCLE!");
      visiting.add(key);
      try {
        value = evaluate(text.slice(1), sheetIndex);
      } finally {
        visiting.delete(key);
      }
    } else {
      const num = cellNumber(text);
      value = num ?? text;
    }
    cache.set(key, value);
    return value;
  }

  type Range = { sheetIndex: number; r1: number; c1: number; r2: number; c2: number };

  function evaluate(src: string, sheetIndex: number): Value {
    const tokens = tokenize(src);
    let pos = 0;
    const peek = () => tokens[pos];
    const isOp = (value: string) => peek()?.kind === "op" && (peek() as { value: string }).value === value;
    const expectOp = (value: string) => {
      if (!isOp(value)) throw new FormulaError("#VALUE!");
      pos++;
    };

    const resolveRange = (token: Extract<Token, { kind: "ref" }>): Range => {
      const target = token.sheet === null ? sheetIndex : sheetIndexByName.get(token.sheet.toLowerCase());
      if (target === undefined) throw new FormulaError("#REF!");
      const a = parseCellAddress(token.from)!;
      const b = token.to ? parseCellAddress(token.to)! : a;
      return {
        sheetIndex: target,
        r1: Math.min(a.row, b.row),
        c1: Math.min(a.col, b.col),
        r2: Math.max(a.row, b.row),
        c2: Math.max(a.col, b.col),
      };
    };

    const rangeValues = (range: Range): Value[] => {
      const values: Value[] = [];
      const sheet = data.sheets[range.sheetIndex];
      // Only the cells the sheet has: a whole-column range (A1:A1048576) shouldn't walk a million empty ones.
      const lastRow = Math.min(range.r2, sheet.rows.length - 1);
      for (let r = range.r1; r <= lastRow; r++) {
        const lastCol = Math.min(range.c2, (sheet.rows[r]?.length ?? 0) - 1);
        for (let c = range.c1; c <= lastCol; c++) values.push(cellValue(range.sheetIndex, r, c));
      }
      return values;
    };

    const toNumber = (value: Value): number => {
      if (isError(value)) throw new FormulaError(value.error);
      if (typeof value === "number") return value;
      if (value.trim() === "") return 0;
      if (value === "TRUE" || value === "FALSE") return value === "TRUE" ? 1 : 0;
      const num = cellNumber(value);
      if (num === null) throw new FormulaError("#VALUE!");
      return num;
    };

    // An argument of a function: a range gives its cells' values, anything else its one value.
    const argument = (): { values: Value[]; fromRange: boolean } => {
      const token = peek();
      const next = tokens[pos + 1];
      if (token?.kind === "ref" && (!next || (next.kind === "op" && (next.value === "," || next.value === ")")))) {
        pos++;
        const range = resolveRange(token);
        return { values: token.to ? rangeValues(range) : [cellValue(range.sheetIndex, range.r1, range.c1)], fromRange: true };
      }
      return { values: [expression()], fromRange: false };
    };

    const numbersOf = (args: { values: Value[]; fromRange: boolean }[], strict = true): number[] => {
      const numbers: number[] = [];
      for (const arg of args) {
        for (const value of arg.values) {
          if (isError(value)) throw new FormulaError(value.error);
          if (typeof value === "number") numbers.push(value);
          // Text in a range is skipped, as Excel does; typed as an argument, it must be a number.
          else if (!arg.fromRange && strict) numbers.push(toNumber(value));
        }
      }
      return numbers;
    };

    const call = (name: string): Value => {
      expectOp("(");
      const args: { values: Value[]; fromRange: boolean }[] = [];
      if (!isOp(")")) {
        args.push(argument());
        while (isOp(",")) {
          pos++;
          args.push(argument());
        }
      }
      expectOp(")");
      switch (name) {
        case "SUM":
          return numbersOf(args).reduce((a, b) => a + b, 0);
        case "AVERAGE": {
          const nums = numbersOf(args);
          if (!nums.length) throw new FormulaError("#DIV/0!");
          return nums.reduce((a, b) => a + b, 0) / nums.length;
        }
        case "COUNT":
          return args.reduce((n, arg) => n + arg.values.filter((v) => typeof v === "number").length, 0);
        case "MIN": {
          const nums = numbersOf(args);
          return nums.length ? Math.min(...nums) : 0;
        }
        case "MAX": {
          const nums = numbersOf(args);
          return nums.length ? Math.max(...nums) : 0;
        }
        case "ABS": {
          const [x] = numbersOf(args);
          if (args.length !== 1 || x === undefined) throw new FormulaError("#VALUE!");
          return Math.abs(x);
        }
        case "ROUND": {
          if (args.length < 1 || args.length > 2) throw new FormulaError("#VALUE!");
          const x = numbersOf([args[0]])[0] ?? 0;
          const digits = args[1] ? Math.trunc(numbersOf([args[1]])[0] ?? 0) : 0;
          const factor = 10 ** digits;
          return Math.sign(x) * (Math.round(Math.abs(x) * factor) / factor);
        }
        default:
          throw new FormulaError("#NAME?");
      }
    };

    const primary = (): Value => {
      const token = peek();
      if (!token) throw new FormulaError("#VALUE!");
      pos++;
      switch (token.kind) {
        case "num":
          return token.value;
        case "str":
          return token.value;
        case "error":
          throw new FormulaError(token.value);
        case "ref": {
          if (token.to) throw new FormulaError("#VALUE!");
          const range = resolveRange(token);
          const value = cellValue(range.sheetIndex, range.r1, range.c1);
          if (isError(value)) throw new FormulaError(value.error);
          return value;
        }
        case "name":
          if (isOp("(")) return call(token.value);
          if (token.value === "TRUE" || token.value === "FALSE") return token.value;
          throw new FormulaError("#NAME?");
        case "op":
          if (token.value === "(") {
            const value = expression();
            expectOp(")");
            return value;
          }
          if (token.value === "-") return -toNumber(unary());
          if (token.value === "+") return toNumber(unary());
          throw new FormulaError("#VALUE!");
      }
    };

    const unary = (): Value => primary();

    const power = (): Value => {
      let left = unary();
      while (isOp("^")) {
        pos++;
        left = toNumber(left) ** toNumber(unary());
      }
      return left;
    };

    const term = (): Value => {
      let left = power();
      while (isOp("*") || isOp("/")) {
        const op = (peek() as { value: string }).value;
        pos++;
        const a = toNumber(left);
        const b = toNumber(power());
        if (op === "/" && b === 0) throw new FormulaError("#DIV/0!");
        left = op === "*" ? a * b : a / b;
      }
      return left;
    };

    const sum = (): Value => {
      let left = term();
      while (isOp("+") || isOp("-")) {
        const op = (peek() as { value: string }).value;
        pos++;
        const a = toNumber(left);
        const b = toNumber(term());
        left = op === "+" ? a + b : a - b;
      }
      return left;
    };

    const expression = (): Value => {
      let left = sum();
      while (isOp("&")) {
        pos++;
        left = formatValue(left) + formatValue(sum());
      }
      return left;
    };

    try {
      const value = expression();
      if (pos < tokens.length) throw new FormulaError("#VALUE!");
      return value;
    } catch (e) {
      if (e instanceof FormulaError) return err(e.code);
      throw e;
    }
  }

  return {
    display: (sheetIndex, row, col) => formatValue(cellValue(sheetIndex, row, col)),
    kind: (sheetIndex, row, col) => {
      const value = cellValue(sheetIndex, row, col);
      return isError(value) ? "error" : typeof value === "number" ? "number" : "text";
    },
  };
}

// --- Workbooks ------------------------------------------------------------------

type XlsxModule = typeof import("xlsx");
let xlsxModule: Promise<XlsxModule> | null = null;
const loadXlsx = () => (xlsxModule ??= import("xlsx"));

/**
 * A workbook (`.xlsx`, `.xlsm`, `.xls`, `.ods`, `.csv`, …) as a spreadsheet: each sheet's cells as text, a formula
 * as its formula. `truncated` if a sheet was bigger than `IMPORT_MAX_ROWS` × `IMPORT_MAX_COLS` and was cut to it.
 */
export async function parseWorkbookBuffer(buffer: ArrayBuffer, title?: string): Promise<{ data: SpreadsheetData; truncated: boolean }> {
  const XLSX = await loadXlsx();
  const book = XLSX.read(buffer, { type: "array", cellFormula: true, cellDates: false });
  const sheets: SpreadsheetSheet[] = [];
  let truncated = false;
  for (const name of book.SheetNames) {
    const ws = book.Sheets[name];
    const ref = ws?.["!ref"];
    if (!ws || !ref) {
      sheets.push({ name: uniqueSheetName(sheets, name), rows: emptyRows() });
      continue;
    }
    const range = XLSX.utils.decode_range(ref);
    const lastRow = Math.min(range.e.r, IMPORT_MAX_ROWS - 1);
    const lastCol = Math.min(range.e.c, IMPORT_MAX_COLS - 1);
    if (range.e.r > lastRow || range.e.c > lastCol) truncated = true;
    const rows: string[][] = [];
    // From A1, so cell addresses stay those of the workbook.
    for (let r = 0; r <= lastRow; r++) {
      const row: string[] = [];
      for (let c = 0; c <= lastCol; c++) {
        const cell = ws[XLSX.utils.encode_cell({ r, c })] as import("xlsx").CellObject | undefined;
        row.push(cell ? workbookCellText(XLSX, cell) : "");
      }
      while (row.length && !row[row.length - 1]) row.pop();
      rows.push(row);
    }
    while (rows.length && !rows[rows.length - 1].length) rows.pop();
    sheets.push({ name: uniqueSheetName(sheets, name), rows: rows.length ? rows : emptyRows() });
  }
  if (!sheets.length) sheets.push({ name: "Sheet1", rows: emptyRows() });
  return { data: { activeSheet: sheets[0].name, sheets, ...(title ? { title } : {}) }, truncated };
}

function workbookCellText(XLSX: XlsxModule, cell: import("xlsx").CellObject): string {
  if (cell.f) return `=${cell.f}`;
  if (cell.v === undefined || cell.v === null) return "";
  switch (cell.t) {
    case "b":
      return cell.v ? "TRUE" : "FALSE";
    case "n":
      // A date is a number formatted as one: keep how it reads.
      return cell.z && XLSX.SSF.is_date(cell.z) && cell.w ? cell.w : String(cell.v);
    case "e":
      return cell.w ?? "#VALUE!";
    default:
      return String(cell.v);
  }
}

/** The file name a spreadsheet exports to: its title, or "Spreadsheet", without characters Windows refuses. */
export function exportFileName(data: SpreadsheetData, format: "xlsx" | "csv"): string {
  const base = (data.title || "Spreadsheet").replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").trim() || "Spreadsheet";
  return `${base}.${format}`;
}

/**
 * Download the spreadsheet as an Excel workbook (every sheet, formulas kept with their values worked out) or as a
 * CSV of the active sheet's values.
 */
export async function exportWorkbook(data: SpreadsheetData, filename?: string, format: "xlsx" | "csv" = "xlsx"): Promise<void> {
  const XLSX = await loadXlsx();
  const evaluator = createEvaluator(data);
  const book = XLSX.utils.book_new();
  const activeIndex = Math.max(
    data.sheets.findIndex((s) => s.name === data.activeSheet),
    0,
  );
  const indices = format === "csv" ? [activeIndex] : data.sheets.map((_, i) => i);
  for (const index of indices) {
    const sheet = data.sheets[index];
    const ws: import("xlsx").WorkSheet = {};
    let maxRow = 0;
    let maxCol = 0;
    sheet.rows.forEach((row, r) =>
      row.forEach((text, c) => {
        if (!text) return;
        maxRow = Math.max(maxRow, r);
        maxCol = Math.max(maxCol, c);
        const addr = XLSX.utils.encode_cell({ r, c });
        const kind = evaluator.kind(index, r, c);
        const shown = evaluator.display(index, r, c);
        const cell: import("xlsx").CellObject = kind === "number" ? { t: "n", v: Number(shown) } : { t: "s", v: shown };
        if (text.startsWith("=") && format === "xlsx") cell.f = text.slice(1);
        ws[addr] = cell;
      }),
    );
    ws["!ref"] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: maxRow, c: maxCol } });
    // Excel's sheet names: at most 31 characters, none of []:*?/\, and no two alike.
    const base = sheet.name.replace(/[[\]:*?/\\]/g, "_").slice(0, 31) || "Sheet";
    let name = base;
    for (let n = 2; book.SheetNames.some((taken) => taken.toLowerCase() === name.toLowerCase()); n++) {
      name = `${base.slice(0, 28)} ${n}`;
    }
    XLSX.utils.book_append_sheet(book, ws, name);
  }
  XLSX.writeFile(book, filename ?? exportFileName(data, format), { bookType: format });
}
