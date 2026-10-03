from datetime import date, datetime

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

import database
import file_layer
import main
from config import Settings
from history import soft_delete
from models import HistoryRecord, Project, Task, TimeLog
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


TODAY = date(2026, 10, 3)


@pytest.fixture
def triage_today(monkeypatch):
    monkeypatch.setattr(main, "_today", lambda: TODAY)
    return TODAY


def _write_capture(path, content, priority=None, created=None, project=None, **extra):
    frontmatter = {"type": "capture", **extra}
    if project is not None:
        frontmatter["project"] = project
    if priority is not None:
        frontmatter["priority"] = priority
    if created is not None:
        frontmatter["created"] = created
    file_layer.write_note(path, content, frontmatter, "write_directly")


@pytest.fixture
def triage_db():
    """Gantt tasks around TODAY (2026-10-03), plus rows the Morning List must leave out."""
    with database.SessionLocal() as session:
        c7801 = Project(code="C7801", name="C7801 Build")
        archived = Project(code="X0001", name="Old job", active=False)
        session.add_all([c7801, archived])
        session.flush()
        gone = Task(project_id=c7801.id, title="Removed", start_date=date(2026, 10, 1), is_gantt_task=True)
        session.add_all(
            [
                Task(project_id=c7801.id, title="Late gelcoat", start_date=date(2026, 9, 20),
                     deadline=date(2026, 10, 2), status=Status.IN_PROGRESS, is_gantt_task=True),
                Task(project_id=c7801.id, title="Very late resin", start_date=date(2026, 9, 1),
                     deadline=date(2026, 9, 15), is_gantt_task=True),
                Task(project_id=c7801.id, title="Running lamination", start_date=date(2026, 9, 28),
                     deadline=date(2026, 10, 10), is_gantt_task=True),
                Task(project_id=c7801.id, title="Starts today", start_date=TODAY,
                     deadline=TODAY, is_gantt_task=True),
                Task(project_id=c7801.id, title="Open-ended", start_date=date(2026, 10, 1), is_gantt_task=True),
                Task(project_id=c7801.id, title="Next week fit-out", start_date=date(2026, 10, 10),
                     deadline=date(2026, 10, 20), is_gantt_task=True),
                Task(project_id=c7801.id, title="Too far ahead", start_date=date(2026, 10, 11), is_gantt_task=True),
                Task(project_id=c7801.id, title="Finished", start_date=date(2026, 9, 1),
                     deadline=date(2026, 9, 10), status=Status.DONE, is_gantt_task=True),
                Task(project_id=c7801.id, title="Imported as complete", description="Complete: 100%",
                     start_date=date(2026, 9, 1), deadline=date(2026, 9, 10), is_gantt_task=True),
                Task(project_id=c7801.id, title="Undated", is_gantt_task=True),
                Task(project_id=c7801.id, title="Design task", start_date=date(2026, 10, 1)),
                Task(project_id=archived.id, title="Archived", start_date=date(2026, 10, 1), is_gantt_task=True),
                gone,
            ]
        )
        session.flush()
        soft_delete(session, gone)
        session.commit()


def test_triage_ranks_tasks_and_notes(client, triage_today, triage_db):
    _write_capture("Inbox/Capture_1.md", "Low idea", "low", "2026-10-01T08:00:00", "Inbox")
    _write_capture("Inbox/Capture_2.md", "Call supplier", "normal", "2026-10-02T09:00:00", "Inbox")
    _write_capture("C7801/Notes-in/Capture_3.md", "Check weld spec", "high", "2026-10-02T10:00:00", "C7801")
    _write_capture("C7801/Notes-in/Capture_4.md", "Older high note", "high", "2026-10-01T10:00:00", "C7801")

    response = client.get("/api/triage")

    assert response.status_code == 200
    items = response.json()
    assert [(i["rank"], i["title"]) for i in items] == [
        (1, "Very late resin"),
        (1, "Late gelcoat"),
        (2, "Starts today"),
        (2, "Running lamination"),
        (2, "Open-ended"),
        (3, "Older high note"),
        (3, "Check weld spec"),
        (4, "Call supplier"),
        (5, "Next week fit-out"),
        (6, "Low idea"),
    ]


def test_triage_item_shapes(client, triage_today, triage_db):
    _write_capture("C7801/Notes-in/Capture_1.md", "# Check weld spec\nOn the transom", "High", "2026-10-02T10:00:00", "C7801")

    items = client.get("/api/triage").json()

    task = next(i for i in items if i["title"] == "Late gelcoat")
    assert task == {
        "id": task["id"],
        "kind": "gantt_task",
        "rank": 1,
        "title": "Late gelcoat",
        "project": "C7801",
        "priority": "normal",
        "status": "in_progress",
        "assignee": None,
        "start_date": "2026-09-20",
        "due_date": "2026-10-02",
        "created": None,
        "path": None,
        "content": None,
    }
    assert task["id"].startswith("task:")
    note = next(i for i in items if i["kind"] == "capture")
    assert note == {
        "id": "note:C7801/Notes-in/Capture_1.md",
        "kind": "capture",
        "rank": 3,
        "title": "Check weld spec",
        "project": "C7801",
        "priority": "high",
        "status": None,
        "assignee": None,
        "start_date": None,
        "due_date": None,
        "created": "2026-10-02T10:00:00",
        "path": "C7801/Notes-in/Capture_1.md",
        "content": "# Check weld spec\nOn the transom",
    }


def test_triage_notes_from_capture_endpoint(client, triage_today):
    client.post("/api/capture", json={"content": "Call supplier", "project": "Inbox", "priority": "High"})
    client.post("/api/capture", json={"content": "Confirm geometry", "project": "R5301", "priority": "Low"})

    items = client.get("/api/triage").json()

    assert [(i["rank"], i["title"], i["project"]) for i in items] == [
        (3, "Call supplier", None),
        (6, "Confirm geometry", "R5301"),
    ]


def test_triage_note_defaults_and_fallbacks(client, notes_dir, triage_today):
    # No priority or created date, project taken from the folder, unknown priority treated as normal.
    (notes_dir / "R5301" / "Notes-in").mkdir(parents=True)
    (notes_dir / "R5301" / "Notes-in" / "plain.md").write_text("Hand-written note\n", encoding="utf-8")
    _write_capture("Inbox/Capture_1.md", "Odd priority", "whenever", "not a date")
    _write_capture("Inbox/Capture_2.md", "Urgent thing", "urgent", "2026-10-02T09:00:00")

    items = client.get("/api/triage").json()

    by_title = {i["title"]: i for i in items}
    assert (by_title["Hand-written note"]["project"], by_title["Hand-written note"]["priority"]) == ("R5301", "normal")
    assert by_title["Hand-written note"]["rank"] == 4
    assert (by_title["Odd priority"]["rank"], by_title["Odd priority"]["created"]) == (4, None)
    assert by_title["Odd priority"]["project"] is None
    assert by_title["Urgent thing"]["rank"] == 3


def test_triage_skips_broken_and_unrelated_notes(client, notes_dir, triage_today):
    (notes_dir / "Inbox").mkdir()
    (notes_dir / "Inbox" / "broken.md").write_text("---\n: [unclosed\n---\nBody\n", encoding="utf-8")
    (notes_dir / "Inbox" / "readme.txt").write_text("not a note", encoding="utf-8")
    _write_capture("Wiki/page.md", "Reference page", "high")
    _write_capture("C7801/Notes-out/Capture_1.md", "Outgoing", "high")
    _write_capture("Inbox/Capture_1.md", "Real capture", "normal")

    items = client.get("/api/triage").json()

    assert [i["title"] for i in items] == ["Real capture"]


def test_triage_with_nothing_to_do(client, triage_today):
    response = client.get("/api/triage")

    assert response.status_code == 200
    assert response.json() == []


def test_claim_task_sets_assignee_and_status(client, triage_today, checkin_db):
    task_id = checkin_db["Very late resin"]

    response = client.patch(f"/api/tasks/{task_id}", json={"assignee": "Jose", "status": "in_progress"})

    assert response.status_code == 200
    body = response.json()
    assert (body["id"], body["assignee"], body["status"], body["completed_at"]) == (task_id, "Jose", "in_progress", None)
    with database.SessionLocal() as session:
        task = session.get(Task, task_id)
        assert (task.assignee, task.status) == ("Jose", Status.IN_PROGRESS)
        record = session.scalars(select(HistoryRecord).where(HistoryRecord.entity_id == str(task_id))
                                 .order_by(HistoryRecord.id.desc())).first()
        assert (record.action, record.source, record.snapshot["assignee"]) == ("update", "desktop", "Jose")
    item = next(i for i in client.get("/api/triage").json() if i["id"] == f"task:{task_id}")
    assert (item["assignee"], item["status"]) == ("Jose", "in_progress")


def test_patch_task_only_changes_fields_sent(client, triage_today, checkin_db):
    task_id = checkin_db["Late gelcoat"]
    client.patch(f"/api/tasks/{task_id}", json={"assignee": " Jose "})

    assert client.patch(f"/api/tasks/{task_id}", json={"status": "blocked"}).json()["assignee"] == "Jose"
    body = client.patch(f"/api/tasks/{task_id}", json={"assignee": None}).json()
    assert (body["assignee"], body["status"]) == (None, "blocked")
    assert client.patch(f"/api/tasks/{task_id}", json={"assignee": ""}).json()["assignee"] is None


def test_patch_task_status_done_sets_and_clears_completion_time(client, triage_today, checkin_db):
    task_id = checkin_db["Late gelcoat"]

    done = client.patch(f"/api/tasks/{task_id}", json={"status": "done"}).json()
    assert done["completed_at"] is not None
    assert client.patch(f"/api/tasks/{task_id}", json={"status": "done"}).json()["completed_at"] == done["completed_at"]
    assert client.patch(f"/api/tasks/{task_id}", json={"status": "in_progress"}).json()["completed_at"] is None


def test_patch_unknown_task(client, triage_today, checkin_db):
    response = client.patch("/api/tasks/9999", json={"assignee": "Jose"})

    assert response.status_code == 404


@pytest.mark.parametrize(
    "payload",
    [{"status": "finished"}, {"status": None}, {"assignee": "x" * 65}],
)
def test_patch_task_rejects_invalid_payloads(client, triage_today, checkin_db, payload):
    task_id = checkin_db["Late gelcoat"]

    response = client.patch(f"/api/tasks/{task_id}", json=payload)

    assert response.status_code == 422
    with database.SessionLocal() as session:
        task = session.get(Task, task_id)
        assert (task.assignee, task.status) == (None, Status.IN_PROGRESS)


@pytest.fixture
def checkin_db():
    """C7801 with two open tasks and one already done; R5301 has no row yet. Returns the task ids by title."""
    with database.SessionLocal() as session:
        c7801 = Project(code="C7801", name="C7801 Build")
        session.add(c7801)
        session.flush()
        tasks = [
            Task(project_id=c7801.id, title="Late gelcoat", start_date=date(2026, 9, 20),
                 deadline=date(2026, 10, 2), status=Status.IN_PROGRESS, is_gantt_task=True),
            Task(project_id=c7801.id, title="Very late resin", start_date=date(2026, 9, 1),
                 deadline=date(2026, 9, 15), is_gantt_task=True),
            Task(project_id=c7801.id, title="Finished", start_date=date(2026, 9, 1), deadline=date(2026, 9, 10),
                 status=Status.DONE, completed_at=datetime(2026, 9, 10, 17, 0), is_gantt_task=True),
        ]
        session.add_all(tasks)
        session.commit()
        return {task.title: task.id for task in tasks}


def _project_ids():
    with database.SessionLocal() as session:
        return {p.code: p.id for p in session.scalars(select(Project).execution_options(include_deleted=True))}


def test_checkin_marks_tasks_done_and_logs_time(client, triage_today, checkin_db):
    payload = {
        "completed_task_ids": [checkin_db["Late gelcoat"]],
        "time_entries": [
            {"project": "C7801", "hours": 4, "notes": " Gelcoat repairs "},
            {"project": "R5301", "hours": 2},
            {"project": "Inbox", "hours": 0.5, "notes": "Emails"},
        ],
    }

    response = client.post("/api/checkin", json=payload)

    assert response.status_code == 200
    body = response.json()
    assert body["completed_task_ids"] == [checkin_db["Late gelcoat"]]
    assert body["total_hours"] == 6.5
    with database.SessionLocal() as session:
        done = session.get(Task, checkin_db["Late gelcoat"])
        assert done.status == Status.DONE and done.completed_at is not None
        assert session.get(Task, checkin_db["Very late resin"]).status == Status.TODO
        logs = session.scalars(select(TimeLog).order_by(TimeLog.id)).all()
    projects = _project_ids()
    assert [log.id for log in logs] == body["time_log_ids"]
    assert [(log.date, log.project_id, log.task_id, log.hours, log.notes) for log in logs] == [
        (TODAY, projects["C7801"], None, 4.0, "Gelcoat repairs"),
        (TODAY, projects["R5301"], None, 2.0, ""),
        (TODAY, None, None, 0.5, "Emails"),
    ]


def test_checkin_removes_done_tasks_from_triage(client, triage_today, checkin_db):
    before = [i["title"] for i in client.get("/api/triage").json()]
    assert before == ["Very late resin", "Late gelcoat"]

    client.post("/api/checkin", json={"completed_task_ids": [checkin_db["Very late resin"]]})

    assert [i["title"] for i in client.get("/api/triage").json()] == ["Late gelcoat"]


def test_checkin_records_history(client, triage_today, checkin_db):
    task_id = checkin_db["Late gelcoat"]
    client.post("/api/checkin", json={"completed_task_ids": [task_id], "time_entries": [{"project": "C7801", "hours": 3}]})

    with database.SessionLocal() as session:
        records = session.scalars(select(HistoryRecord).where(HistoryRecord.source == "evening_checkin")).all()
    by_type = {r.entity_type: r for r in records}
    assert len(records) == 2
    assert (by_type["Task"].entity_id, by_type["Task"].action) == (str(task_id), "update")
    assert by_type["Task"].snapshot["status"] == "done"
    assert by_type["Task"].snapshot["completed_at"] is not None
    assert by_type["TimeLog"].action == "create"
    assert by_type["TimeLog"].snapshot["hours"] == 3.0
    assert by_type["TimeLog"].snapshot["date"] == TODAY.isoformat()


def test_checkin_keeps_completion_time_of_already_done_tasks(client, triage_today, checkin_db):
    task_id = checkin_db["Finished"]

    response = client.post("/api/checkin", json={"completed_task_ids": [task_id, task_id]})

    assert response.status_code == 200
    assert response.json()["completed_task_ids"] == [task_id]
    with database.SessionLocal() as session:
        assert session.get(Task, task_id).completed_at == datetime(2026, 9, 10, 17, 0)
        assert session.scalars(select(HistoryRecord).where(HistoryRecord.source == "evening_checkin")).all() == []


def test_checkin_project_codes(client, triage_today, checkin_db):
    entries = [
        {"project": "c7801", "hours": 1},
        {"project": "Overhead", "hours": 1},
        {"project": None, "hours": 1},
        {"project": "p5002", "hours": 1},
        {"project": "P5002", "hours": 1},
    ]

    client.post("/api/checkin", json={"time_entries": entries, "day": "2026-10-02"})

    projects = _project_ids()
    assert set(projects) == {"C7801", "P5002"}
    with database.SessionLocal() as session:
        logs = session.scalars(select(TimeLog).order_by(TimeLog.id)).all()
        assert session.get(Project, projects["P5002"]).name == "P5002"
    assert [log.project_id for log in logs] == [projects["C7801"], None, None, projects["P5002"], projects["P5002"]]
    assert {log.date for log in logs} == {date(2026, 10, 2)}


def test_checkin_unknown_task_changes_nothing(client, triage_today, checkin_db):
    payload = {
        "completed_task_ids": [checkin_db["Late gelcoat"], 9999],
        "time_entries": [{"project": "C7801", "hours": 4}],
    }

    response = client.post("/api/checkin", json=payload)

    assert response.status_code == 404
    assert "9999" in response.json()["detail"]
    with database.SessionLocal() as session:
        assert session.get(Task, checkin_db["Late gelcoat"]).status == Status.IN_PROGRESS
        assert session.scalars(select(TimeLog)).all() == []


def test_checkin_ignores_soft_deleted_tasks(client, triage_today, checkin_db):
    with database.SessionLocal() as session:
        soft_delete(session, session.get(Task, checkin_db["Very late resin"]))
        session.commit()

    response = client.post("/api/checkin", json={"completed_task_ids": [checkin_db["Very late resin"]]})

    assert response.status_code == 404


@pytest.mark.parametrize(
    "entry",
    [
        {"project": "C7801", "hours": 0},
        {"project": "C7801", "hours": -1},
        {"project": "C7801", "hours": 25},
        {"project": "C7801"},
        {"project": "../C7801", "hours": 1},
        {"project": "", "hours": 1},
    ],
)
def test_checkin_rejects_invalid_time_entries(client, triage_today, checkin_db, entry):
    response = client.post("/api/checkin", json={"time_entries": [entry]})

    assert response.status_code == 422
    with database.SessionLocal() as session:
        assert session.scalars(select(TimeLog)).all() == []


def test_checkin_with_nothing_to_report(client, triage_today):
    response = client.post("/api/checkin", json={})

    assert response.status_code == 200
    assert response.json() == {"completed_task_ids": [], "time_log_ids": [], "total_hours": 0.0}


# --- Saved prompts (slash commands) -------------------------------------------


def test_default_prompts_are_seeded_once(client):
    prompts = client.get("/api/prompts").json()
    assert [p["command"] for p in prompts] == ["/prep"]
    assert prompts[0]["instruction"]

    client.delete(f"/api/prompts/{prompts[0]['id']}")
    with database.SessionLocal() as db:
        main.seed_prompts(db)
    assert client.get("/api/prompts").json() == []


def test_prompt_crud(client):
    created = client.post(
        "/api/prompts", json={"command": " Weekly ", "description": " Weekly report ", "instruction": " Summarise. "}
    )
    assert created.status_code == 201
    prompt = created.json()
    assert (prompt["command"], prompt["description"], prompt["instruction"]) == ("/weekly", "Weekly report", "Summarise.")
    assert [p["command"] for p in client.get("/api/prompts").json()] == ["/prep", "/weekly"]

    updated = client.put(f"/api/prompts/{prompt['id']}", json={"command": "/week", "instruction": "Summarise the week."})
    assert updated.status_code == 200
    assert updated.json()["command"] == "/week"
    assert updated.json()["description"] == ""

    assert client.delete(f"/api/prompts/{prompt['id']}").status_code == 204
    assert [p["command"] for p in client.get("/api/prompts").json()] == ["/prep"]
    assert client.delete(f"/api/prompts/{prompt['id']}").status_code == 404
    assert client.put(f"/api/prompts/{prompt['id']}", json={"command": "/x", "instruction": "y"}).status_code == 404

    with database.SessionLocal() as db:
        actions = db.scalars(
            select(HistoryRecord.action).where(
                HistoryRecord.entity_type == "SavedPrompt", HistoryRecord.entity_id == str(prompt["id"])
            )
        ).all()
    assert actions == ["create", "update", "delete"]


def test_prompt_commands_are_unique_among_live_prompts(client):
    first = client.post("/api/prompts", json={"command": "/brief", "instruction": "a"}).json()
    assert client.post("/api/prompts", json={"command": "/BRIEF", "instruction": "b"}).status_code == 409
    assert client.put(f"/api/prompts/{first['id']}", json={"command": "/prep", "instruction": "a"}).status_code == 409
    # Saving a prompt under its own command is fine.
    assert client.put(f"/api/prompts/{first['id']}", json={"command": "/brief", "instruction": "c"}).status_code == 200

    client.delete(f"/api/prompts/{first['id']}")
    assert client.post("/api/prompts", json={"command": "/brief", "instruction": "d"}).status_code == 201


@pytest.mark.parametrize(
    "payload",
    [
        {"command": "/prep me", "instruction": "x"},
        {"command": "/", "instruction": "x"},
        {"command": "/a" + "b" * 31, "instruction": "x"},
        {"command": "/ok", "instruction": "   "},
        {"command": "/ok"},
    ],
)
def test_prompt_rejects_invalid_payloads(client, payload):
    assert client.post("/api/prompts", json=payload).status_code == 422


# --- Notes tree ----------------------------------------------------------------


def test_list_notes_with_titles(client, notes_dir):
    (notes_dir / "C7801" / "Meetings").mkdir(parents=True)
    (notes_dir / "C7801" / "Meetings" / "review.md").write_text("---\ntitle: Design review\n---\nBody\n", encoding="utf-8")
    (notes_dir / "C7801" / "plan.md").write_text("# Build plan\n\nText\n", encoding="utf-8")
    (notes_dir / "Inbox").mkdir()
    (notes_dir / "Inbox" / "empty.md").write_text("", encoding="utf-8")
    (notes_dir / ".trash").mkdir()
    (notes_dir / ".trash" / "old.md").write_text("old", encoding="utf-8")

    assert client.get("/api/notes").json() == [
        {"path": "C7801/Meetings/review.md", "title": "Design review"},
        {"path": "C7801/plan.md", "title": "Build plan"},
        {"path": "Inbox/empty.md", "title": "empty"},
    ]


def test_get_note_file(client, notes_dir):
    (notes_dir / "a.md").write_bytes(b"---\ncreated: 2026-09-30\n---\nHello\n")
    assert client.get("/api/notes/file", params={"path": "a.md"}).json() == {
        "path": "a.md",
        "frontmatter": {"created": "2026-09-30"},
        "content": "Hello\n",
    }
    assert client.get("/api/notes/file", params={"path": "missing.md"}).status_code == 404
    assert client.get("/api/notes/file", params={"path": "../x.md"}).status_code == 400


def test_capture_records_source(client, notes_dir):
    path = client.post("/api/capture", json={"content": "Hi", "source": "Verbal"}).json()["path"]
    assert file_layer.read_note(path)["frontmatter"]["source"] == "verbal"
