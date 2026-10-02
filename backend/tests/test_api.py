from datetime import datetime

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

import database
import file_layer
import main
from config import Settings
from models import HistoryRecord


@pytest.fixture
def notes_dir(tmp_path, monkeypatch):
    root = tmp_path / "notes"
    root.mkdir()
    monkeypatch.setattr(file_layer, "get_settings", lambda: Settings(_env_file=None, notes_dir=root))
    return root


@pytest.fixture
def client(notes_dir, monkeypatch):
    # Avoid touching the real copilot.db during tests.
    monkeypatch.setattr(main, "init_db", lambda: None)
    with TestClient(main.app) as client:
        yield client


def test_capture_saves_note_in_project_notes_in(client, notes_dir):
    response = client.post("/api/capture", json={"content": "Check weld spec", "project": "C7801", "priority": "High"})

    assert response.status_code == 200
    path = response.json()["path"]
    assert path.startswith("C7801/Notes-in/Capture_") and path.endswith(".md")
    note = file_layer.read_note(path)
    assert note["content"] == "Check weld spec"
    assert note["frontmatter"]["type"] == "capture"
    assert note["frontmatter"]["project"] == "C7801"
    assert note["frontmatter"]["priority"] == "high"
    datetime.fromisoformat(note["frontmatter"]["created"])
    assert (notes_dir / path).is_file()


def test_capture_inbox_goes_to_inbox_folder(client):
    response = client.post("/api/capture", json={"content": "Call supplier", "project": "Inbox", "priority": "Normal"})

    assert response.status_code == 200
    path = response.json()["path"]
    assert path.startswith("Inbox/Capture_")
    assert "/Notes-in/" not in path


def test_capture_defaults_to_inbox_and_normal_priority(client):
    response = client.post("/api/capture", json={"content": "Idea"})

    assert response.status_code == 200
    note = file_layer.read_note(response.json()["path"])
    assert note["frontmatter"]["project"] == "Inbox"
    assert note["frontmatter"]["priority"] == "normal"


def test_capture_is_recorded_in_history_as_android_app(client):
    path = client.post("/api/capture", json={"content": "Logged", "project": "R5301", "priority": "Low"}).json()["path"]

    with database.SessionLocal() as session:
        records = session.scalars(select(HistoryRecord).where(HistoryRecord.entity_type == "Note")).all()
    assert [(r.entity_id, r.action, r.source) for r in records] == [(path, "create", "android_app")]


def test_captures_in_the_same_second_do_not_overwrite(client, monkeypatch):
    fixed = datetime(2026, 10, 2, 9, 30, 0)
    monkeypatch.setattr(main, "datetime", type("FixedDatetime", (), {"now": staticmethod(lambda: fixed)}))

    first = client.post("/api/capture", json={"content": "one", "project": "P5002"}).json()["path"]
    second = client.post("/api/capture", json={"content": "two", "project": "P5002"}).json()["path"]

    assert first == "P5002/Notes-in/Capture_20261002_093000.md"
    assert second == "P5002/Notes-in/Capture_20261002_093000_2.md"
    assert file_layer.read_note(first)["content"] == "one"
    assert file_layer.read_note(second)["content"] == "two"


@pytest.mark.parametrize(
    "payload",
    [
        {"content": "", "project": "C7801"},
        {"content": "   \n", "project": "C7801"},
        {"project": "C7801"},
        {"content": "x", "project": "../escape"},
        {"content": "x", "project": "C7801/sub"},
        {"content": "x", "project": ""},
        {"content": "x", "priority": "Whenever"},
    ],
)
def test_capture_rejects_invalid_payloads(client, notes_dir, payload):
    response = client.post("/api/capture", json=payload)

    assert response.status_code == 422
    assert not any(notes_dir.rglob("*.md"))
