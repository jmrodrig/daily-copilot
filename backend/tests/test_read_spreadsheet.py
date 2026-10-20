"""The spreadsheet reader (`read_spreadsheet`) and how `read_local_file` and the agent's tool use it."""

import json

import openpyxl
import pytest

import agent
import local_files
import read_spreadsheet
from read_spreadsheet import SpreadsheetReadError
from schemas import AccessMode


@pytest.fixture
def workbook(tmp_path):
    """A budget with a costs sheet (numbers and formulas, no saved values: written by a script) and a notes sheet."""
    book = openpyxl.Workbook()
    costs = book.active
    costs.title = "Costs"
    costs.append(["Item", "Qty", "Unit price", "Total"])
    costs.append(["Keel bolts", 12, 45.5, "=B2*C2"])
    costs.append(["Lead ballast", 1, 8200, "=B3*C3"])
    costs.append(["Total", None, None, "=SUM(D2:D3)"])
    notes = book.create_sheet("Notes")
    notes.append(["Supplier", "Comment"])
    notes.append(["Yard A", "Keel delivered in May"])
    path = tmp_path / "budget.xlsx"
    book.save(path)
    return path


def test_reads_every_sheet_with_cells_and_formulas(workbook):
    data = read_spreadsheet.read_spreadsheet(workbook)

    assert [s["name"] for s in data["sheets"]] == ["Costs", "Notes"]
    costs = data["sheets"][0]
    assert (costs["rows"], costs["cols"]) == (4, 4)
    assert costs["cells"][1][:3] == ["Keel bolts", "12", "45.5"]
    # No saved value: the cell shows its formula.
    assert costs["cells"][1][3] == "=B2*C2"
    assert costs["formulas"] == {"D2": "=B2*C2", "D3": "=B3*C3", "D4": "=SUM(D2:D3)"}
    assert data["sheets"][1]["formulas"] == {}


def test_selects_one_sheet_ignoring_case(workbook):
    data = read_spreadsheet.read_spreadsheet(workbook, sheet=" notes ")
    assert [s["name"] for s in data["sheets"]] == ["Notes"]


def test_unknown_sheet_names_the_sheets(workbook):
    with pytest.raises(SpreadsheetReadError, match="Costs, Notes"):
        read_spreadsheet.read_spreadsheet(workbook, sheet="Hull")


def test_search_finds_cells_by_value_and_formula(workbook):
    data = read_spreadsheet.read_spreadsheet(workbook, search="KEEL")
    assert [(m["sheet"], m["cell"]) for m in data["matches"]] == [("Costs", "A2"), ("Notes", "B2")]
    assert data["matches"][0]["row"] == ["Keel bolts", "12", "45.5", "=B2*C2"]

    by_formula = read_spreadsheet.read_spreadsheet(workbook, search="sum(")["matches"]
    assert [(m["cell"], m["formula"]) for m in by_formula] == [("D4", "=SUM(D2:D3)")]
    assert read_spreadsheet.read_spreadsheet(workbook, search="  ")["matches"] == []


def test_reads_csv_and_tsv(tmp_path):
    csv_file = tmp_path / "parts.csv"
    csv_file.write_text("Part;Mass\nKeel;8200\nRudder;150\n\n", encoding="utf-8")
    tsv_file = tmp_path / "parts.tsv"
    tsv_file.write_text("Part\tMass\nMast\t300\n", encoding="utf-8")

    sheet = read_spreadsheet.read_spreadsheet(csv_file)["sheets"][0]
    assert sheet["name"] == "parts" and sheet["cells"] == [["Part", "Mass"], ["Keel", "8200"], ["Rudder", "150"]]
    assert read_spreadsheet.read_spreadsheet(tsv_file)["sheets"][0]["cells"][1] == ["Mast", "300"]


@pytest.mark.parametrize(
    "name, content, message",
    [
        ("missing.xlsx", None, "File not found"),
        ("old.xls", b"x", "save old.xls as .xlsx"),
        ("notes.txt", b"x", "Not a spreadsheet"),
        ("broken.xlsx", b"not a zip", "Not a readable Excel workbook"),
    ],
)
def test_errors(tmp_path, name, content, message):
    path = tmp_path / name
    if content is not None:
        path.write_bytes(content)
    with pytest.raises(SpreadsheetReadError, match=message):
        read_spreadsheet.read_spreadsheet(path)


def test_cell_text_and_col_letter():
    assert [read_spreadsheet.col_letter(i) for i in (1, 26, 27, 52, 703)] == ["A", "Z", "AA", "AZ", "AAA"]
    assert read_spreadsheet.cell_text(3.0) == "3"
    assert read_spreadsheet.cell_text(True) == "TRUE"
    assert read_spreadsheet.cell_text(None) == ""


def test_format_shows_tables_formulas_and_limits(workbook):
    text = read_spreadsheet.format_spreadsheet(read_spreadsheet.read_spreadsheet(workbook), max_rows=2)
    assert "  - Costs: 4 rows × 4 columns, 3 formulas" in text
    assert "| # | Item | Qty | Unit price | Total |" in text
    assert "| 2 | Keel bolts | 12 | 45.5 | =B2*C2 |" in text
    assert "... [1 more rows]" in text
    assert "  - D4: =SUM(D2:D3)" in text

    found = read_spreadsheet.format_spreadsheet(read_spreadsheet.read_spreadsheet(workbook, search="ballast"))
    assert 'Matches for "ballast": 1' in found and "Costs!A3: Lead ballast" in found


def test_cli_prints_json_and_errors(workbook, capsys):
    assert read_spreadsheet.main([str(workbook), "--sheet", "Costs", "--json", "--max-rows", "1"]) == 0
    out = json.loads(capsys.readouterr().out)
    assert out["sheets"][0]["cells"] == [["Item", "Qty", "Unit price", "Total"], ["Keel bolts", "12", "45.5", "=B2*C2"]]
    assert out["sheets"][0]["truncated"] is True

    assert read_spreadsheet.main([str(workbook.with_name("nope.xlsx"))]) == 1
    assert "File not found" in capsys.readouterr().err


def test_read_local_file_reads_spreadsheets(workbook):
    result = local_files.read_local_file(str(workbook))
    assert result["sheets"] == ["Costs", "Notes"]
    assert "| 3 | Lead ballast | 1 | 8200 | =B3*C3 |" in result["content"]

    workbook.with_name("bad.xlsx").write_bytes(b"nope")
    with pytest.raises(local_files.LocalFileError, match="Could not read the spreadsheet"):
        local_files.read_local_file(str(workbook.with_name("bad.xlsx")))


def test_agent_tool_reads_a_sheet_and_searches(workbook):
    result = agent.read_spreadsheet_tool(workbook.as_uri(), sheet="Costs")
    assert result["sheets"] == [{"name": "Costs", "rows": 4, "cols": 4}]
    assert "=SUM(D2:D3)" in result["content"]

    found = agent.read_spreadsheet_tool(str(workbook), search="yard")
    assert "Notes!A2: Yard A" in found["content"]


def test_agent_tool_errors_become_tool_errors(tmp_path):
    turn = agent._Turn(AccessMode.READ_ONLY)
    with pytest.raises(agent.ToolError, match="File not found"):
        turn.call("read_spreadsheet", {"path": str(tmp_path / "missing.xlsx")})
