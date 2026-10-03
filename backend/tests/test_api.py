from datetime import date, datetime

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

import database
import file_layer
import main
from config import Settings
from history import soft_delete
from models import HistoryRecord, Project, Task
from schemas import Status


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


@pytest.fixture
def gantt_db():
    """Two projects with shop floor tasks, plus rows the Gantt must leave out."""
    with database.SessionLocal() as session:
        c7801 = Project(code="C7801", name="C7801 Build")
        r5301 = Project(code="R5301", name="R5301 Refit")
        archived = Project(code="X0001", name="Old job", active=False)
        session.add_all([c7801, r5301, archived])
        session.flush()
        gone = Task(project_id=c7801.id, title="Removed", start_date=date(2026, 9, 1), is_gantt_task=True)
        session.add_all(
            [
                Task(
                    project_id=c7801.id,
                    title="Hatch fitting",
                    description="Section: Deck\nComplete: 40%",
                    status=Status.IN_PROGRESS,
                    start_date=date(2026, 10, 20),
                    deadline=date(2026, 11, 5),
                    is_gantt_task=True,
                ),
                Task(
                    project_id=c7801.id,
                    title="Hull moulding",
                    status=Status.DONE,
                    start_date=date(2026, 9, 28),
                    deadline=date(2026, 10, 14),
                    is_gantt_task=True,
                ),
                Task(project_id=c7801.id, title="Undated", description=" |  | 25%", is_gantt_task=True),
                Task(
                    project_id=c7801.id,
                    title="M3",
                    start_date=date(2026, 11, 5),
                    deadline=date(2026, 11, 5),
                    is_gantt_task=True,
                    is_milestone=True,
                ),
                Task(project_id=c7801.id, title="Design task", start_date=date(2026, 9, 1)),
                Task(project_id=archived.id, title="Archived", start_date=date(2026, 9, 1), is_gantt_task=True),
                gone,
            ]
        )
        session.flush()
        soft_delete(session, gone)
        session.commit()


def test_gantt_groups_shop_floor_tasks_by_project(client, gantt_db):
    response = client.get("/api/gantt")

    assert response.status_code == 200
    projects = response.json()["projects"]
    assert [(p["code"], p["name"]) for p in projects] == [("C7801", "C7801 Build"), ("R5301", "R5301 Refit")]
    assert projects[1]["tasks"] == []
    tasks = projects[0]["tasks"]
    assert [t["name"] for t in tasks] == ["Hull moulding", "Hatch fitting", "M3", "Undated"]
    assert tasks[1] == {
        "id": tasks[1]["id"],
        "name": "Hatch fitting",
        "start_date": "2026-10-20",
        "end_date": "2026-11-05",
        "completion_percent": 40.0,
        "status": "in_progress",
        "is_milestone": False,
    }


def test_gantt_completion_percent(client, gantt_db):
    tasks = client.get("/api/gantt").json()["projects"][0]["tasks"]

    percent = {t["name"]: t["completion_percent"] for t in tasks}
    assert percent == {"Hull moulding": 100.0, "Hatch fitting": 40.0, "M3": 0.0, "Undated": 25.0}
    milestone = next(t for t in tasks if t["name"] == "M3")
    assert milestone["is_milestone"] is True
    undated = next(t for t in tasks if t["name"] == "Undated")
    assert undated["start_date"] is None and undated["end_date"] is None


def test_gantt_with_empty_database(client):
    response = client.get("/api/gantt")

    assert response.status_code == 200
    assert response.json() == {"projects": []}
