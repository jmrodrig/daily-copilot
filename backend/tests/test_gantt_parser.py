import json
from types import SimpleNamespace

import pymupdf
import pytest

import gantt_parser
from config import Settings
from gantt_parser import GanttParseError, extract_gantt_data, extract_pdf_text, parse_llm_json

LLM_RESULT = {
    "project_code": "C7801",
    "project_name": "C7801 Project Plan",
    "tasks": [
        {
            "id": "T1",
            "name": "Keel delivery",
            "parent": "Superstructure & deck",
            "trade": "Sub contractor",
            "start": "2027-03-01",
            "end": "2027-03-05",
            "percent_complete": 0,
        },
        {
            "id": "T2",
            "name": "Keel install",
            "parent": "Superstructure & deck",
            "trade": "Boatbuilding",
            "start": "2027-03-08",
            "end": "2027-03-19",
            "percent_complete": None,
        },
    ],
    "dependencies": [{"predecessor": "T1", "successor": "T2", "type": "finish_to_start", "lag_days": 0}],
    "milestones": [{"name": "STAGE PAYMENT - Roll out/keel", "date": "2027-03-22"}],
}


@pytest.fixture
def gantt_pdf(tmp_path):
    path = tmp_path / "C7801 Project Plan.pdf"
    doc = pymupdf.open()
    page = doc.new_page(width=842, height=595)
    page.insert_text((300, 50), "01/03/2027")
    page.insert_text((400, 50), "08/03/2027")
    page.insert_text((50, 100), "Keel delivery")
    page.insert_text((300, 100), "Sub contractor")
    page.insert_text((50, 130), "Keel install")
    page.insert_text((400, 130), "Boatbuilding")
    doc.save(path)
    doc.close()
    return path


@pytest.fixture
def settings():
    return Settings(_env_file=None, gemini_api_key="test-key", gantt_model="gemini/test-model")


@pytest.fixture
def fake_completion(monkeypatch):
    """Replace litellm.completion so tests never call the real API."""
    calls = []
    reply = {"content": json.dumps(LLM_RESULT)}

    def completion(**kwargs):
        calls.append(kwargs)
        message = SimpleNamespace(content=reply["content"])
        return SimpleNamespace(choices=[SimpleNamespace(message=message)])

    monkeypatch.setattr(gantt_parser.litellm, "completion", completion)
    return SimpleNamespace(calls=calls, reply=reply)


def test_extract_pdf_text_includes_positions(gantt_pdf):
    text = extract_pdf_text(gantt_pdf)
    assert text.startswith("=== Page 1 (842x595 pt) ===")
    lines = text.splitlines()
    # Header row comes before task rows, and each line carries its coordinates.
    assert lines.index(next(l for l in lines if "01/03/2027" in l)) < lines.index(
        next(l for l in lines if "Keel delivery" in l)
    )
    assert any(l.startswith("[50-") and l.endswith("Keel install") for l in lines)


def test_extract_pdf_text_missing_file(tmp_path):
    with pytest.raises(FileNotFoundError):
        extract_pdf_text(tmp_path / "missing.pdf")


def test_extract_pdf_text_rejects_pdf_without_text(tmp_path):
    path = tmp_path / "blank.pdf"
    doc = pymupdf.open()
    doc.new_page()
    doc.save(path)
    doc.close()
    with pytest.raises(GanttParseError, match="No text"):
        extract_pdf_text(path)


def test_extract_gantt_data_returns_structured_json(gantt_pdf, settings, fake_completion):
    data = extract_gantt_data(str(gantt_pdf), settings=settings)

    assert data == LLM_RESULT
    json.dumps(data)  # JSON-ready: dates come back as ISO strings


def test_extract_gantt_data_sends_pdf_text_and_key_from_config(gantt_pdf, settings, fake_completion):
    extract_gantt_data(str(gantt_pdf), settings=settings)

    (call,) = fake_completion.calls
    assert call["model"] == "gemini/test-model"
    assert call["api_key"] == "test-key"
    assert call["response_format"] == {"type": "json_object"}
    system, user = call["messages"]
    assert "valid JSON" in system["content"]
    for term in ("tasks", "dependencies", "milestones", "finish-to-start"):
        assert term in system["content"]
    assert "Keel delivery" in user["content"]
    assert "C7801 Project Plan.pdf" in user["content"]


def test_extract_gantt_data_requires_api_key(gantt_pdf, fake_completion):
    settings = Settings(_env_file=None, gemini_api_key=None)
    with pytest.raises(GanttParseError, match="COPILOT_GEMINI_API_KEY"):
        extract_gantt_data(str(gantt_pdf), settings=settings)
    assert fake_completion.calls == []


def test_extract_gantt_data_rejects_invalid_json(gantt_pdf, settings, fake_completion):
    fake_completion.reply["content"] = "Here are the tasks: ..."
    with pytest.raises(GanttParseError, match="valid JSON"):
        extract_gantt_data(str(gantt_pdf), settings=settings)


def test_parse_llm_json_strips_markdown_fence():
    content = "```json\n" + json.dumps(LLM_RESULT) + "\n```"
    assert parse_llm_json(content)["tasks"][1]["name"] == "Keel install"


def test_parse_llm_json_defaults_missing_lists():
    data = parse_llm_json('{"tasks": [{"id": "T1", "name": "Launch prep"}]}')
    assert data["dependencies"] == [] and data["milestones"] == []
    assert data["tasks"][0]["start"] is None


@pytest.mark.parametrize(
    "payload, message",
    [
        ({"tasks": [{"id": "T1", "name": "A", "start": "01/03/2027"}]}, "schema"),
        ({"tasks": [{"id": "T1", "name": "A"}, {"id": "T1", "name": "B"}]}, "unique"),
        ({"tasks": [{"id": "T1", "name": "A"}], "dependencies": [{"predecessor": "T1", "successor": "T9"}]}, "unknown"),
        ({"tasks": [], "dependencies": [{"predecessor": "T1", "successor": "T2", "type": "start_to_start"}]}, "schema"),
    ],
)
def test_parse_llm_json_rejects_bad_structure(payload, message):
    with pytest.raises(GanttParseError, match=message):
        parse_llm_json(json.dumps(payload))


def test_parse_llm_json_rejects_empty_response():
    with pytest.raises(GanttParseError, match="empty"):
        parse_llm_json(None)
