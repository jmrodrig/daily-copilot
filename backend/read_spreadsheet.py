"""Read spreadsheets (`.xlsx`, `.xlsm`, `.csv`, `.tsv`): their sheets, headers, cells and formulas, for the agent or a
person at a shell.

    python read_spreadsheet.py budget.xlsx                       # every sheet's size, then each as a markdown table
    python read_spreadsheet.py budget.xlsx --sheet Costs         # just one sheet
    python read_spreadsheet.py budget.xlsx --search "keel"       # the cells (and their rows) that mention "keel"
    python read_spreadsheet.py budget.xlsx --max-rows 200 --max-cols 30
    python read_spreadsheet.py budget.xlsx --json                # everything as JSON

A sheet's first row is taken as its headers. Cells show their saved values; a formula's cell shows its formula when
the file holds no saved value for it (as a file written by a script, not Excel, may not), and `--json` (or the
"Formulas" list under each table) gives every formula. Uses `openpyxl` (imported when a workbook is read).
"""

import argparse
import csv
import json
import sys
from datetime import date, datetime, time
from pathlib import Path
from typing import Any

EXCEL_SUFFIXES = {".xlsx", ".xlsm"}
CSV_SUFFIXES = {".csv", ".tsv"}
SPREADSHEET_SUFFIXES = EXCEL_SUFFIXES | CSV_SUFFIXES

DEFAULT_MAX_ROWS = 50
DEFAULT_MAX_COLS = 20
# The formulas listed under a sheet's table, and the search matches kept: more say little the agent can use.
MAX_FORMULAS = 50
MAX_MATCHES = 100


class SpreadsheetReadError(Exception):
    """The file is missing, isn't a supported spreadsheet, or couldn't be read."""


def col_letter(index: int) -> str:
    """The column letters of a 1-based column index: 1 → A, 27 → AA."""
    letters = ""
    while index > 0:
        index, rest = divmod(index - 1, 26)
        letters = chr(65 + rest) + letters
    return letters


def cell_text(value: Any) -> str:
    """A cell's value as it reads: whole floats without `.0`, dates without a midnight time, booleans as Excel shows them."""
    if value is None:
        return ""
    if isinstance(value, bool):
        return "TRUE" if value else "FALSE"
    if isinstance(value, float) and value.is_integer() and abs(value) < 1e15:
        return str(int(value))
    if isinstance(value, datetime):
        return value.date().isoformat() if value.time() == time() else value.isoformat(sep=" ")
    if isinstance(value, (date, time)):
        return value.isoformat()
    return str(value)


def _trimmed(rows: list[list[str]]) -> list[list[str]]:
    """`rows` without the empty rows and columns at their end, every row as wide as the widest."""
    while rows and not any(rows[-1]):
        rows.pop()
    width = max((max((i + 1 for i, v in enumerate(row) if v), default=0) for row in rows), default=0)
    return [(row + [""] * width)[:width] for row in rows]


def _sheet(name: str, rows: list[list[str]], formulas: dict[str, str]) -> dict[str, Any]:
    rows = _trimmed(rows)
    return {"name": name, "rows": len(rows), "cols": len(rows[0]) if rows else 0, "cells": rows, "formulas": formulas}


def _read_csv(path: Path) -> list[dict[str, Any]]:
    try:
        text = path.read_text(encoding="utf-8-sig", errors="replace")
    except OSError as exc:
        raise SpreadsheetReadError(f"Could not read {path}: {exc}") from exc
    if path.suffix.lower() == ".tsv":
        dialect: Any = csv.excel_tab
    else:
        try:
            dialect = csv.Sniffer().sniff(text[:8192], delimiters=",;\t|")
        except csv.Error:
            dialect = csv.excel
    rows = [list(row) for row in csv.reader(text.splitlines(), dialect)]
    return [_sheet(path.stem, rows, {})]


def _read_excel(path: Path) -> list[dict[str, Any]]:
    try:
        import openpyxl
    except ImportError as exc:  # pragma: no cover - depends on the environment
        raise SpreadsheetReadError("openpyxl is not installed (pip install openpyxl)") from exc

    try:
        # Read twice: once for the values Excel saved, once for the formulas behind them.
        values_book = openpyxl.load_workbook(path, read_only=True, data_only=True)
        formulas_book = openpyxl.load_workbook(path, read_only=True, data_only=False)
    except Exception as exc:  # openpyxl raises zipfile, XML and its own errors for files it can't read
        raise SpreadsheetReadError(f"Not a readable Excel workbook: {path} ({exc})") from exc

    try:
        sheets = []
        for values_sheet, formulas_sheet in zip(values_book.worksheets, formulas_book.worksheets):
            rows: list[list[str]] = []
            formulas: dict[str, str] = {}
            pairs = zip(values_sheet.iter_rows(values_only=True), formulas_sheet.iter_rows(values_only=True))
            for r, (values, raws) in enumerate(pairs, start=1):
                row = []
                for c, (value, raw) in enumerate(zip(values, raws), start=1):
                    is_formula = isinstance(raw, str) and raw.startswith("=")
                    if is_formula:
                        formulas[f"{col_letter(c)}{r}"] = raw
                    row.append(cell_text(raw if is_formula and value is None else value))
                rows.append(row)
            sheets.append(_sheet(values_sheet.title, rows, formulas))
        return sheets
    except Exception as exc:
        raise SpreadsheetReadError(f"Could not read {path}: {exc}") from exc
    finally:
        values_book.close()
        formulas_book.close()


def read_spreadsheet(
    file_path: str | Path,
    *,
    sheet: str | None = None,
    search: str | None = None,
) -> dict[str, Any]:
    """The spreadsheet in `file_path` as a dict: `path` and `sheets`, each with its `name`, `rows` and `cols` (its
    used size), `cells` (every row, as text) and `formulas` (cell → formula, for workbooks). With `sheet`, only that
    sheet (matched case-insensitively); with `search`, also `matches`: the cells whose value or formula contains it.

    Raises `SpreadsheetReadError` if the file is missing, isn't a supported spreadsheet, couldn't be read, or has
    no sheet named `sheet`.
    """
    path = Path(file_path)
    if not path.is_file():
        raise SpreadsheetReadError(f"File not found: {path}")
    suffix = path.suffix.lower()
    if suffix == ".xls":
        raise SpreadsheetReadError(f"Old-style .xls workbooks aren't supported: save {path.name} as .xlsx first")
    if suffix not in SPREADSHEET_SUFFIXES:
        raise SpreadsheetReadError(f"Not a spreadsheet ({', '.join(sorted(SPREADSHEET_SUFFIXES))}): {path}")

    sheets = _read_csv(path) if suffix in CSV_SUFFIXES else _read_excel(path)
    if sheet is not None:
        chosen = [s for s in sheets if s["name"].lower() == sheet.strip().lower()]
        if not chosen:
            names = ", ".join(s["name"] for s in sheets)
            raise SpreadsheetReadError(f'No sheet named "{sheet}" in {path.name} (its sheets: {names})')
        sheets = chosen

    data: dict[str, Any] = {"path": str(path), "sheets": sheets}
    if search is not None:
        data["search"] = search
        data["matches"] = find_cells(sheets, search)
    return data


def find_cells(sheets: list[dict[str, Any]], query: str) -> list[dict[str, Any]]:
    """The cells whose value or formula contains `query` (ignoring case), with their sheet, address and row."""
    needle = query.strip().lower()
    if not needle:
        return []
    matches = []
    for sheet in sheets:
        for r, row in enumerate(sheet["cells"], start=1):
            for c, value in enumerate(row, start=1):
                address = f"{col_letter(c)}{r}"
                formula = sheet["formulas"].get(address, "")
                if needle in value.lower() or needle in formula.lower():
                    matches.append({"sheet": sheet["name"], "cell": address, "value": value, "formula": formula or None, "row": row})
                    if len(matches) >= MAX_MATCHES:
                        return matches
    return matches


def _md(value: str) -> str:
    """A cell's text, safe in a markdown table cell."""
    return value.replace("\r\n", " ").replace("\n", " ").replace("|", "\\|").strip()


def sheet_table(sheet: dict[str, Any], max_rows: int = DEFAULT_MAX_ROWS, max_cols: int = DEFAULT_MAX_COLS) -> str:
    """A sheet as a markdown table: its first row as the headers (an empty one as its column letter), each row led
    by its row number so cells can be named (B7), and at most `max_rows` data rows and `max_cols` columns."""
    cells: list[list[str]] = sheet["cells"]
    if not cells:
        return "(empty sheet)"
    cols = min(sheet["cols"], max(max_cols, 1))
    header = ["#"] + [_md(v) or col_letter(i) for i, v in enumerate(cells[0][:cols], start=1)]
    lines = ["| " + " | ".join(header) + " |", "|" + " --- |" * len(header)]
    body = cells[1 : 1 + max(max_rows, 0)]
    for r, row in enumerate(body, start=2):
        lines.append("| " + " | ".join([str(r), *(_md(v) for v in row[:cols])]) + " |")
    notes = []
    if len(cells) - 1 > len(body):
        notes.append(f"{len(cells) - 1 - len(body)} more rows")
    if sheet["cols"] > cols:
        notes.append(f"{sheet['cols'] - cols} more columns")
    if notes:
        lines.append(f"... [{', '.join(notes)}]")
    return "\n".join(lines)


def format_spreadsheet(data: dict[str, Any], max_rows: int = DEFAULT_MAX_ROWS, max_cols: int = DEFAULT_MAX_COLS) -> str:
    """A readable summary of `read_spreadsheet`'s result: the sheets and their sizes, then the search matches if it
    searched, else each sheet as a markdown table with its formulas."""
    sheets = data["sheets"]
    lines = [f"File: {data['path']}", f"Sheets ({len(sheets)}):"]
    for sheet in sheets:
        formulas = f", {len(sheet['formulas'])} formulas" if sheet["formulas"] else ""
        lines.append(f"  - {sheet['name']}: {sheet['rows']} rows × {sheet['cols']} columns{formulas}")

    if "matches" in data:
        matches = data["matches"]
        more = " (showing the first ones)" if len(matches) >= MAX_MATCHES else ""
        lines += ["", f'Matches for "{data["search"]}": {len(matches)}{more}']
        for match in matches:
            formula = f" ({match['formula']})" if match["formula"] else ""
            row = " | ".join(_md(v) for v in match["row"])
            lines.append(f"  - {match['sheet']}!{match['cell']}: {_md(match['value'])}{formula}  ← row: {row}")
        return "\n".join(lines)

    for sheet in sheets:
        lines += ["", f"## {sheet['name']} ({sheet['rows']} rows × {sheet['cols']} columns)", "", sheet_table(sheet, max_rows, max_cols)]
        formulas = list(sheet["formulas"].items())
        if formulas:
            lines += ["", "Formulas:"]
            lines += [f"  - {cell}: {formula}" for cell, formula in formulas[:MAX_FORMULAS]]
            if len(formulas) > MAX_FORMULAS:
                lines.append(f"  ... [{len(formulas) - MAX_FORMULAS} more formulas]")
    return "\n".join(lines)


def _limited(data: dict[str, Any], max_rows: int, max_cols: int) -> dict[str, Any]:
    """`data` with each sheet's cells cut to its headers plus `max_rows` rows and `max_cols` columns, for `--json`."""
    sheets = []
    for sheet in data["sheets"]:
        cells = [row[:max_cols] for row in sheet["cells"][: max_rows + 1]]
        sheets.append({**sheet, "cells": cells, "truncated": len(cells) < sheet["rows"] or sheet["cols"] > max_cols})
    return {**data, "sheets": sheets}


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Read a spreadsheet (.xlsx, .xlsm, .csv, .tsv): sheets, headers, cells and formulas.")
    parser.add_argument("file", help="Path to the spreadsheet")
    parser.add_argument("--sheet", metavar="NAME", help="Only this sheet (default: every sheet)")
    parser.add_argument("--search", metavar="QUERY", help="List the cells whose value or formula contains QUERY, with their rows")
    parser.add_argument("--max-rows", type=int, default=DEFAULT_MAX_ROWS, metavar="N", help=f"Data rows shown per sheet (default: {DEFAULT_MAX_ROWS})")
    parser.add_argument("--max-cols", type=int, default=DEFAULT_MAX_COLS, metavar="N", help=f"Columns shown per sheet (default: {DEFAULT_MAX_COLS})")
    parser.add_argument("--json", action="store_true", help="Print everything as JSON")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        data = read_spreadsheet(args.file, sheet=args.sheet, search=args.search)
    except SpreadsheetReadError as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1
    if args.json:
        print(json.dumps(_limited(data, args.max_rows, args.max_cols), indent=2, ensure_ascii=False))
    else:
        print(format_spreadsheet(data, args.max_rows, args.max_cols))
    return 0


if __name__ == "__main__":
    # Cells often hold characters the Windows console code page can't print.
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.exit(main())
