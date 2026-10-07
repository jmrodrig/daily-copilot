"""Archived status, space preferences (status flow, custom fields), bulk task updates and People."""

from datetime import date

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

import database
import main
from models import HistoryRecord, Project, Task
from schemas import Status, clean_status_flow


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setattr(main, "init_db", lambda: None)
    with TestClient(main.app) as client:
        yield client


def new_task(client, title, **fields):
    response = client.post("/api/tasks", json={"space_id": 1, "title": title, **fields})
    assert response.status_code == 201, response.text
    return response.json()


def titles(client, **params):
    return [t["title"] for t in client.get("/api/tasks", params={"space_id": 1, **params}).json()]


# --- Archived -----------------------------------------------------------------------


def test_archived_tasks_are_hidden_unless_asked_for(client):
    new_task(client, "Live")
    archived = new_task(client, "Old", status="archived")

    assert archived["status"] == "archived"
    assert titles(client) == ["Live"]
    assert titles(client, include_archived=True) == ["Live", "Old"]
    assert titles(client, status="archived") == ["Old"]
    # Still reachable on its own, e.g. from a link in a note.
    assert client.get(f"/api/tasks/{archived['id']}").json()["title"] == "Old"


def test_archived_gantt_tasks_leave_the_gantt_and_triage(client, monkeypatch):
    monkeypatch.setattr(main, "_today", lambda: date(2026, 10, 7))
    with database.SessionLocal() as db:
        project = Project(code="C7801", name="Keel")
        db.add(project)
        db.flush()
        for title, status in (("Weld", Status.TODO), ("Paint", Status.ARCHIVED)):
            db.add(
                Task(
                    space_id=1,
                    project_id=project.id,
                    title=title,
                    status=status,
                    is_gantt_task=True,
                    start_date=date(2026, 10, 1),
                    deadline=date(2026, 10, 20),
                )
            )
        db.commit()

    gantt = client.get("/api/gantt").json()["projects"][0]["tasks"]
    assert [t["name"] for t in gantt] == ["Weld"]
    assert [i["title"] for i in client.get("/api/triage").json()] == ["Weld"]


# --- Space preferences --------------------------------------------------------------


def test_space_preferences_round_trip(client):
    response = client.put(
        "/api/spaces/1",
        json={
            "status_flow": {"todo": ["in_progress", "in_progress", "archived"], "done": []},
            "custom_fields_schema": [
                {"id": "hull", "name": " Hull no. ", "type": "text"},
                {"id": "weight", "name": "Weight", "type": "number"},
            ],
        },
    )

    assert response.status_code == 200, response.text
    space = response.json()
    assert space["name"] == "Default"  # unsent fields are kept
    assert space["status_flow"] == {"todo": ["in_progress", "archived"], "done": []}
    assert space["custom_fields_schema"] == [
        {"id": "hull", "name": "Hull no.", "type": "text"},
        {"id": "weight", "name": "Weight", "type": "number"},
    ]
    assert client.get("/api/spaces").json()[0]["status_flow"] == {"todo": ["in_progress", "archived"], "done": []}

    # Renaming keeps the preferences; a null flow allows every move again.
    assert client.put("/api/spaces/1", json={"name": "Work"}).json()["custom_fields_schema"][0]["id"] == "hull"
    assert client.put("/api/spaces/1", json={"status_flow": None}).json()["status_flow"] is None
    assert client.put("/api/spaces/1", json={"status_flow": {}}).json()["status_flow"] is None


@pytest.mark.parametrize(
    "payload",
    [
        {"name": None},
        {"status_flow": {"todo": ["nope"]}},
        {"status_flow": {"nope": ["todo"]}},
        {"custom_fields_schema": [{"id": "Has Spaces", "name": "x"}]},
        {"custom_fields_schema": [{"id": "a", "name": "A"}, {"id": "a", "name": "B"}]},
        {"custom_fields_schema": [{"id": "a", "name": "A", "type": "colour"}]},
        {"custom_fields_schema": [{"id": "a", "name": " "}]},
    ],
)
def test_space_preferences_validation(client, payload):
    assert client.put("/api/spaces/1", json=payload).status_code == 422


def test_stored_status_flow_is_cleaned():
    flow = clean_status_flow({"todo": ["in_progress", "nope"], "done": [], "bad": ["todo"]})
    assert flow == {Status.DONE: []}  # a list with an unknown status is dropped whole
    assert clean_status_flow({"todo": ["in_progress"]}) == {Status.TODO: [Status.IN_PROGRESS]}
    assert clean_status_flow(None) is None
    assert clean_status_flow({}) is None


# --- Custom fields ------------------------------------------------------------------


@pytest.fixture
def custom_fields(client):
    client.put(
        "/api/spaces/1",
        json={
            "custom_fields_schema": [
                {"id": "hull", "name": "Hull", "type": "text"},
                {"id": "weight", "name": "Weight", "type": "number"},
                {"id": "survey", "name": "Survey", "type": "date"},
                {"id": "signed", "name": "Signed off", "type": "checkbox"},
            ]
        },
    )


def test_custom_fields_are_merged_and_cleared(client, custom_fields):
    task = new_task(client, "Keel", custom_fields={"hull": " H-12 ", "weight": 4.5})
    assert task["custom_fields"] == {"hull": "H-12", "weight": 4.5}

    patched = client.patch(
        f"/api/tasks/{task['id']}", json={"custom_fields": {"survey": "2026-11-01", "signed": True, "hull": None}}
    )
    assert patched.status_code == 200, patched.text
    assert patched.json()["custom_fields"] == {"weight": 4.5, "survey": "2026-11-01", "signed": True}
    # An empty text or date clears the field too.
    client.patch(f"/api/tasks/{task['id']}", json={"custom_fields": {"survey": "", "hull": "  "}})
    assert client.get(f"/api/tasks/{task['id']}").json()["custom_fields"] == {"weight": 4.5, "signed": True}


@pytest.mark.parametrize(
    "values",
    [
        {"unknown": "x"},
        {"weight": "heavy"},
        {"weight": True},
        {"survey": "next week"},
        {"signed": "yes"},
        {"hull": 12},
    ],
)
def test_custom_field_values_are_checked(client, custom_fields, values):
    task = new_task(client, "Keel")
    response = client.patch(f"/api/tasks/{task['id']}", json={"custom_fields": values})
    assert response.status_code == 400
    assert client.post("/api/tasks", json={"space_id": 1, "title": "x", "custom_fields": values}).status_code == 400
    assert client.patch(f"/api/tasks/{task['id']}", json={"custom_fields": None}).status_code == 422


# --- Bulk update --------------------------------------------------------------------


def test_bulk_update_changes_every_task(client):
    a, b, c = (new_task(client, title)["id"] for title in ("A", "B", "C"))

    response = client.post(
        "/api/tasks/bulk-update", json={"task_ids": [a, b, a], "updates": {"status": "done", "assignee": " Jose "}}
    )

    assert response.status_code == 200, response.text
    assert [(t["id"], t["status"], t["assignee"]) for t in response.json()] == [(a, "done", "Jose"), (b, "done", "Jose")]
    assert client.get(f"/api/tasks/{c}").json()["status"] == "backlog"
    with database.SessionLocal() as db:
        assert db.get(Task, a).completed_at is not None
        updates = db.scalars(
            select(HistoryRecord).where(HistoryRecord.entity_type == "Task", HistoryRecord.action == "update")
        ).all()
        assert sorted(int(r.entity_id) for r in updates) == [a, b]

    client.post("/api/tasks/bulk-update", json={"task_ids": [a, b], "updates": {"status": "archived"}})
    assert titles(client) == ["C"]


def test_bulk_update_is_all_or_nothing(client, custom_fields):
    a = new_task(client, "A")["id"]

    assert client.post("/api/tasks/bulk-update", json={"task_ids": [a, 999], "updates": {"status": "done"}}).status_code == 404
    bad_field = {"task_ids": [a], "updates": {"status": "done", "custom_fields": {"weight": "x"}}}
    assert client.post("/api/tasks/bulk-update", json=bad_field).status_code == 400
    assert client.get(f"/api/tasks/{a}").json()["status"] == "backlog"
    assert client.post("/api/tasks/bulk-update", json={"task_ids": [], "updates": {}}).status_code == 422
    assert client.post("/api/tasks/bulk-update", json={"task_ids": [a], "updates": {"status": None}}).status_code == 422


# --- People -------------------------------------------------------------------------


def test_people_crud(client):
    other = client.post("/api/spaces", json={"name": "Private"}).json()["id"]
    created = client.post(
        "/api/people",
        json={"space_id": 1, "name": " Zoe Smith ", "email": "zoe@yard.example", "company": " ", "is_external": False},
    )
    assert created.status_code == 201, created.text
    zoe = created.json()
    assert zoe | {"id": 0, "created_at": None} == {
        "id": 0,
        "space_id": 1,
        "name": "Zoe Smith",
        "email": "zoe@yard.example",
        "company": None,
        "is_external": False,
        "avatar_url": None,
        "created_at": None,
    }
    client.post("/api/people", json={"space_id": 1, "name": "alan Client", "company": "Acme", "is_external": True})
    client.post("/api/people", json={"space_id": other, "name": "Elsewhere"})

    assert [p["name"] for p in client.get("/api/people", params={"space_id": 1}).json()] == ["alan Client", "Zoe Smith"]
    assert [p["name"] for p in client.get("/api/people", params={"space_id": other}).json()] == ["Elsewhere"]
    assert client.get("/api/people", params={"space_id": 99}).status_code == 404

    updated = client.put(
        f"/api/people/{zoe['id']}",
        json={"space_id": 1, "name": "Zoe Smith", "avatar_url": "https://example.com/z.png", "is_external": True},
    )
    assert updated.status_code == 200
    assert (updated.json()["email"], updated.json()["is_external"]) == (None, True)
    assert client.put(f"/api/people/{zoe['id']}", json={"space_id": other, "name": "Zoe"}).status_code == 400

    assert client.delete(f"/api/people/{zoe['id']}").status_code == 204
    assert client.get(f"/api/people/{zoe['id']}").status_code == 404
    assert client.delete(f"/api/people/{zoe['id']}").status_code == 404
    assert [p["name"] for p in client.get("/api/people", params={"space_id": 1}).json()] == ["alan Client"]


@pytest.mark.parametrize(
    "payload, status",
    [
        ({"space_id": 1, "name": " "}, 422),
        ({"space_id": 1, "name": "X", "email": "not-an-email"}, 422),
        ({"space_id": 1, "name": "X", "avatar_url": "javascript:alert(1)"}, 422),
        ({"space_id": 99, "name": "X"}, 404),
    ],
)
def test_create_person_validation(client, payload, status):
    assert client.post("/api/people", json=payload).status_code == status
