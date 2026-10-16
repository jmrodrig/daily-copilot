"""Task dependencies ("blocks" / "blocked by"): the link API, cycle checks and date conflicts."""

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

import database
import main
from models import HistoryRecord


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setattr(main, "init_db", lambda: None)
    with TestClient(main.app) as client:
        yield client


def new_task(client, title, space_id=1, **fields):
    response = client.post("/api/tasks", json={"space_id": space_id, "title": title, **fields})
    assert response.status_code == 201, response.text
    return response.json()["id"]


def link(client, predecessor_id, successor_id):
    return client.post("/api/links", json={"predecessor_id": predecessor_id, "successor_id": successor_id})


def test_create_list_and_delete_links(client):
    design, weld, paint = new_task(client, "Design"), new_task(client, "Weld"), new_task(client, "Paint")

    created = link(client, design, weld)
    assert created.status_code == 201, created.text
    assert created.json() | {"id": 0} == {
        "id": 0,
        "predecessor_id": design,
        "successor_id": weld,
        "type": "finish_to_start",
        "lag_days": 0,
        "conflict": False,
        "conflict_reason": None,
    }
    link(client, weld, paint)

    links = client.get("/api/links", params={"space_id": 1}).json()
    assert [(l["predecessor_id"], l["successor_id"]) for l in links] == [(design, weld), (weld, paint)]

    deps = client.get(f"/api/tasks/{weld}/links").json()
    assert [(d["task_id"], d["title"], d["status"]) for d in deps["blocked_by"]] == [(design, "Design", "backlog")]
    assert [d["task_id"] for d in deps["blocks"]] == [paint]

    link_id = deps["blocked_by"][0]["link_id"]
    assert client.delete(f"/api/links/{link_id}").status_code == 204
    assert client.delete(f"/api/links/{link_id}").status_code == 404
    assert client.get(f"/api/tasks/{weld}/links").json()["blocked_by"] == []
    with database.SessionLocal() as db:
        actions = db.scalars(
            select(HistoryRecord.action).where(HistoryRecord.entity_type == "Link", HistoryRecord.entity_id == str(link_id))
        ).all()
    assert actions == ["create", "delete"]

    # A deleted link can be made again (it is revived, keeping its id).
    again = link(client, design, weld)
    assert again.status_code == 201
    assert again.json()["id"] == link_id


def test_link_validation(client):
    other_space = client.post("/api/spaces", json={"name": "Private"}).json()["id"]
    a, b, c = new_task(client, "A"), new_task(client, "B"), new_task(client, "C")
    elsewhere = new_task(client, "Elsewhere", space_id=other_space)

    assert link(client, a, a).status_code == 400
    assert link(client, a, 999).status_code == 404
    assert link(client, a, elsewhere).status_code == 400
    assert link(client, a, b).status_code == 201
    assert link(client, a, b).status_code == 400  # duplicate
    assert link(client, b, c).status_code == 201

    for predecessor, successor in ((b, a), (c, a)):
        cycle = link(client, predecessor, successor)
        assert cycle.status_code == 400
        assert "circular" in cycle.json()["detail"]

    client.delete(f"/api/tasks/{c}")
    assert link(client, c, a).status_code == 404
    # Deleting a task takes its links with it.
    assert [(l["predecessor_id"], l["successor_id"]) for l in client.get("/api/links").json()] == [(a, b)]
    assert client.get("/api/links", params={"space_id": 99}).status_code == 404


def test_date_conflicts(client):
    design = new_task(client, "Design", start_date="2026-10-01", deadline="2026-10-10")
    weld = new_task(client, "Weld", start_date="2026-10-08", deadline="2026-10-20")
    paint = new_task(client, "Paint", deadline="2026-10-05")
    ship = new_task(client, "Ship", start_date="2026-10-10")
    paint_same_day = new_task(client, "PaintSameDay", deadline="2026-10-10")
    launch = new_task(client, "Launch", start_date="2026-10-11")

    clash = link(client, design, weld).json()
    assert clash["conflict"] is True
    assert clash["conflict_reason"] == "Design finishes on 2026-10-10, after Weld starts on 2026-10-08"
    # Without a start date, the successor's deadline is checked.
    assert link(client, design, paint).json()["conflict_reason"] == (
        "Design finishes on 2026-10-10, after Paint is due on 2026-10-05"
    )
    # 0-day tolerance: the predecessor occupies its finish day, so starting (or being due) that same day clashes.
    same_day = link(client, design, ship).json()
    assert same_day["conflict"] is True
    assert same_day["conflict_reason"] == "Design finishes on 2026-10-10, the same day Ship starts on 2026-10-10"
    same_day_due = link(client, design, paint_same_day).json()
    assert same_day_due["conflict"] is True
    assert same_day_due["conflict_reason"] == (
        "Design finishes on 2026-10-10, the same day PaintSameDay is due on 2026-10-10"
    )
    # Starting the next day is fine.
    assert link(client, design, launch).json()["conflict"] is False

    deps = client.get(f"/api/tasks/{design}/links").json()
    assert [(d["title"], d["conflict"]) for d in deps["blocks"]] == [
        ("Weld", True), ("Paint", True), ("Ship", True), ("PaintSameDay", True), ("Launch", False)
    ]

    client.patch(f"/api/tasks/{weld}", json={"start_date": "2026-10-11"})
    weld_link = next(l for l in client.get("/api/links").json() if l["successor_id"] == weld)
    assert weld_link["conflict"] is False
    assert client.get(f"/api/tasks/{weld}/links").json()["blocked_by"][0]["conflict"] is False
