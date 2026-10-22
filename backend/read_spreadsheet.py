"""Read spreadsheets (`.xlsx`, `.xlsm`, `.csv`, `.tsv`): their sheets, headers, cells and formulas, for the agent or a
person at a shell; and change their cells, for the agent (`edit_spreadsheet`).

    python read_spreadsheet.py budget.xlsx                       # every sheet's size, then each as a markdown table
    python read_spreadsheet.py budget.xlsx --sheet Costs         # just one sheet
    python read_spreadsheet.py budget.xlsx --search "keel"       # the cells (and their rows) that mention "keel"
    python read_spreadsheet.py budget.xlsx --max-rows 200 --max-cols 30
    python read_spreadsheet.py budget.xlsx --json                # everything as JSON

A sheet's first row is taken as its headers. Cells show their saved values; a formula's cell shows its formula when
the file holds no saved value for it (as a file written by a script, not Excel, may not), and `--json` (or the
"Formulas" list under each table) gives every formula. A workbook's defined names (`KeelWeight` → `Costs!$B$2`) are
listed with its sheets. Uses `openpyxl` (imported when a workbook is read).
"""

import argparse
import csv
import json
import re
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


def _defined_names(book: Any) -> dict[str, str]:
    """A workbook's defined names (not those of one sheet), each to the cells it labels (`Costs!$B$2`)."""
    return {name: defined.attr_text for name, defined in book.defined_names.items() if defined.attr_text and not defined.hidden}


def _read_excel(path: Path) -> tuple[list[dict[str, Any]], dict[str, str]]:
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
        return sheets, _defined_names(formulas_book)
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
    used size), `cells` (every row, as text) and `formulas` (cell → formula, for workbooks), and a workbook's defined
    `names` (name → cells, `{"KeelWeight": "Costs!$B$2"}`) if it has any. With `sheet`, only that sheet (matched
    case-insensitively); with `search`, also `matches`: the cells whose value or formula contains it.

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

    sheets, names = (_read_csv(path), {}) if suffix in CSV_SUFFIXES else _read_excel(path)
    if sheet is not None:
        chosen = [s for s in sheets if s["name"].lower() == sheet.strip().lower()]
        if not chosen:
            names = ", ".join(s["name"] for s in sheets)
            raise SpreadsheetReadError(f'No sheet named "{sheet}" in {path.name} (its sheets: {names})')
        sheets = chosen

    data: dict[str, Any] = {"path": str(path), "sheets": sheets}
    if names:
        data["names"] = names
    if search is not None:
        data["search"] = search
        data["matches"] = find_cells(sheets, search)
    return data


# --- Editing ------------------------------------------------------------------------

_NUMBER_RE = re.compile(r"\A[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?\Z")


def cell_value(value: Any) -> Any:
    """What a cell is set to from a value given as text or JSON: a number for digits (`"150"`, `12.5`), TRUE and
    FALSE as booleans, a formula (`"=SUM(B2:B9)"`) or any other text as it is, and nothing for `""` or None."""
    if value is None or isinstance(value, (bool, int, float)):
        return value
    text = str(value)
    stripped = text.strip()
    if not stripped:
        return None
    if _NUMBER_RE.match(stripped):
        number = float(stripped)
        return int(number) if number.is_integer() and "." not in stripped and "e" not in stripped.lower() else number
    if stripped.upper() in {"TRUE", "FALSE"}:
        return stripped.upper() == "TRUE"
    return text


def _cells_of(range_text: str) -> tuple[int, int, int, int]:
    """(min_col, min_row, max_col, max_row), 1-based, of a range (`A1:C10`) or a single cell (`B2`)."""
    from openpyxl.utils.cell import range_boundaries

    try:
        min_col, min_row, max_col, max_row = range_boundaries(range_text.strip().replace("$", "").upper())
    except (ValueError, TypeError) as exc:
        raise SpreadsheetReadError(f"Not a cell or range: {range_text!r} (e.g. `B2` or `A1:C10`)") from exc
    if None in (min_col, min_row, max_col, max_row):
        raise SpreadsheetReadError(f"Not a cell or range: {range_text!r} (e.g. `B2` or `A1:C10`)")
    return min_col, min_row, max_col, max_row  # type: ignore[return-value]


_NAME_RE = re.compile(r"\A[A-Za-z_][A-Za-z0-9_.]*\Z")
_CELL_RE = re.compile(r"\A\$?[A-Za-z]{1,3}\$?\d+\Z")
_SHEET_REF_RE = re.compile(r"\A(?:'((?:[^']|'')+)'|([A-Za-z_][\w.]*))!(.+)\Z")


def _check_name(name: str) -> str:
    """`name` if a defined name may be it, as in Excel: a letter or `_`, then letters, digits, `_` and `.`, and not a
    cell's address (`B2`), TRUE or FALSE."""
    text = name.strip()
    if not _NAME_RE.match(text) or _CELL_RE.match(text) or text.upper() in {"TRUE", "FALSE"} or text.lower().startswith("_xlnm."):
        raise SpreadsheetReadError(
            f"Not a name a cell can have: {name!r} (a letter or _, then letters, digits, _ or ., and not a cell's address)"
        )
    return text


def _quote_sheet(title: str) -> str:
    """A sheet's name as a reference writes it: quoted unless it's a plain word."""
    plain = re.match(r"\A[A-Za-z_][\w.]*\Z", title) and not _CELL_RE.match(title)
    return title if plain else "'" + title.replace("'", "''") + "'"


def _name_ref(book: Any, default_sheet: str, ref: str) -> str:
    """A defined name's reference (`B2`, `A1:A10`, `Costs!B2`, `'Hull data'!A1:A5`) as the workbook keeps it: on its
    sheet (else `default_sheet`), absolute (`Costs!$B$2`)."""
    text = ref.strip().lstrip("=")
    match = _SHEET_REF_RE.match(text)
    sheet_name, cells = default_sheet, text
    if match:
        sheet_name = match.group(1).replace("''", "'") if match.group(1) else match.group(2)
        cells = match.group(3)
    sheet = next((ws.title for ws in book.worksheets if ws.title.lower() == sheet_name.lower()), None)
    if sheet is None:
        names = ", ".join(ws.title for ws in book.worksheets)
        raise SpreadsheetReadError(f'No sheet named "{sheet_name}" for the name\'s cells {ref!r} (its sheets: {names})')
    min_col, min_row, max_col, max_row = _cells_of(cells)
    start = f"${col_letter(min_col)}${min_row}"
    end = f"${col_letter(max_col)}${max_row}"
    return f"{_quote_sheet(sheet)}!{start}" + ("" if start == end else f":{end}")


def _set_names(book: Any, default_sheet: str, names: dict[str, Any]) -> list[str]:
    """Define (or, given `""` or None, remove) each of `names` in `book`, matching an existing name whatever its case."""
    from openpyxl.workbook.defined_name import DefinedName

    changed = []
    for name, ref in names.items():
        text = _check_name(name)
        for existing in [n for n in book.defined_names if n.lower() == text.lower()]:
            del book.defined_names[existing]
        if ref is None or not str(ref).strip():
            changed.append(f"-{text}")
            continue
        book.defined_names[text] = DefinedName(text, attr_text=_name_ref(book, default_sheet, str(ref)))
        changed.append(text)
    return changed


def _edit_csv(path: Path, updates: dict[str, Any], clear_range: str | None, add_sheet: str | None) -> list[str]:
    if add_sheet:
        raise SpreadsheetReadError(f"{path.name} is a {path.suffix} file: it has one sheet, and can't take another")
    text = path.read_text(encoding="utf-8-sig", errors="replace") if path.exists() else ""
    if path.suffix.lower() == ".tsv":
        dialect: Any = csv.excel_tab
    else:
        try:
            dialect = csv.Sniffer().sniff(text[:8192], delimiters=",;\t|")
        except csv.Error:
            dialect = csv.excel
    rows = [list(row) for row in csv.reader(text.splitlines(), dialect)]

    def put(row: int, col: int, value: str) -> None:
        while len(rows) < row:
            rows.append([])
        while len(rows[row - 1]) < col:
            rows[row - 1].append("")
        rows[row - 1][col - 1] = value

    changed = []
    if clear_range:
        min_col, min_row, max_col, max_row = _cells_of(clear_range)
        for r in range(min_row, min(max_row, len(rows)) + 1):
            for c in range(min_col, min(max_col, len(rows[r - 1])) + 1):
                rows[r - 1][c - 1] = ""
        changed.append(clear_range.upper())
    for address, value in updates.items():
        min_col, min_row, max_col, max_row = _cells_of(address)
        if (min_col, min_row) != (max_col, max_row):
            raise SpreadsheetReadError(f"Updates take single cells, not a range: {address}")
        put(min_row, min_col, cell_text(cell_value(value)))
        changed.append(f"{col_letter(min_col)}{min_row}")
    with path.open("w", encoding="utf-8", newline="") as fh:
        csv.writer(fh, delimiter=dialect.delimiter, lineterminator="\r\n").writerows(_trimmed(rows))
    return changed


def edit_spreadsheet(
    file_path: str | Path,
    *,
    sheet: str | None = None,
    updates: dict[str, Any] | None = None,
    add_sheet: str | None = None,
    clear_range: str | None = None,
    create: bool = False,
    names: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Change cells of the spreadsheet in `file_path` and save it: add a sheet named `add_sheet`, empty the cells of
    `clear_range` (`A1:C10`), then set each cell of `updates` (`{"B2": 150, "B4": "=SUM(B2:B3)"}`; see `cell_value`),
    on `sheet` (matched case-insensitively), else the sheet just added, else the workbook's active one. With
    `create`, a missing file is made, as a workbook with one empty sheet (or an empty CSV). A workbook's defined
    `names` are set too (`{"KeelWeight": "B2", "Prices": "Costs!A1:A10"}`, a reference without a sheet being on the
    sheet edited), or removed (`{"KeelWeight": None}`).

    Returns `path`, the `sheet` edited, the `sheets` the file has, the cells `changed` (and the names, a removed one
    as `-Name`), and the workbook's defined `names` if it has any. Raises `SpreadsheetReadError` as
    `read_spreadsheet` does, and for a bad address, name or sheet name, or a sheet name that's taken.
    """
    path = Path(file_path)
    suffix = path.suffix.lower()
    if suffix == ".xls":
        raise SpreadsheetReadError(f"Old-style .xls workbooks aren't supported: save {path.name} as .xlsx first")
    if suffix not in SPREADSHEET_SUFFIXES:
        raise SpreadsheetReadError(f"Not a spreadsheet ({', '.join(sorted(SPREADSHEET_SUFFIXES))}): {path}")
    if not path.is_file() and not create:
        raise SpreadsheetReadError(f"File not found: {path}")
    updates = dict(updates or {})

    if suffix in CSV_SUFFIXES:
        if sheet and sheet.strip().lower() != path.stem.lower():
            raise SpreadsheetReadError(f'No sheet named "{sheet}" in {path.name} (its sheets: {path.stem})')
        if names:
            raise SpreadsheetReadError(f"{path.name} is a {path.suffix} file: it can't have defined names")
        changed = _edit_csv(path, updates, clear_range, add_sheet)
        return {"path": str(path), "sheet": path.stem, "sheets": [path.stem], "changed": changed}

    try:
        import openpyxl
    except ImportError as exc:  # pragma: no cover - depends on the environment
        raise SpreadsheetReadError("openpyxl is not installed (pip install openpyxl)") from exc

    if path.is_file():
        try:
            book = openpyxl.load_workbook(path, keep_vba=suffix == ".xlsm")
        except Exception as exc:  # openpyxl raises zipfile, XML and its own errors for files it can't read
            raise SpreadsheetReadError(f"Not a readable Excel workbook: {path} ({exc})") from exc
    else:
        book = openpyxl.Workbook()
        book.active.title = "Sheet1"

    target = None
    if add_sheet and add_sheet.strip():
        name = add_sheet.strip()
        if any(ws.title.lower() == name.lower() for ws in book.worksheets):
            raise SpreadsheetReadError(f'{path.name} has a sheet named "{name}" already')
        target = book.create_sheet(name[:31])
    if sheet and sheet.strip():
        chosen = [ws for ws in book.worksheets if ws.title.lower() == sheet.strip().lower()]
        if not chosen:
            names = ", ".join(ws.title for ws in book.worksheets)
            raise SpreadsheetReadError(f'No sheet named "{sheet}" in {path.name} (its sheets: {names})')
        target = chosen[0]
    ws = target or book.active

    changed = []
    if clear_range:
        min_col, min_row, max_col, max_row = _cells_of(clear_range)
        for row in ws.iter_rows(min_row=min_row, max_row=max_row, min_col=min_col, max_col=max_col):
            for cell in row:
                cell.value = None
        changed.append(clear_range.strip().upper())
    for address, value in updates.items():
        min_col, min_row, max_col, max_row = _cells_of(address)
        if (min_col, min_row) != (max_col, max_row):
            raise SpreadsheetReadError(f"Updates take single cells, not a range: {address}")
        ws.cell(row=min_row, column=min_col).value = cell_value(value)
        changed.append(f"{col_letter(min_col)}{min_row}")
    if names:
        changed += _set_names(book, ws.title, names)

    path.parent.mkdir(parents=True, exist_ok=True)
    book.save(path)
    result = {"path": str(path), "sheet": ws.title, "sheets": [s.title for s in book.worksheets], "changed": changed}
    defined = _defined_names(book)
    return {**result, "names": defined} if defined else result


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
    if data.get("names"):
        lines.append(f"Defined names ({len(data['names'])}):")
        lines += [f"  - {name}: {ref}" for name, ref in data["names"].items()]

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
