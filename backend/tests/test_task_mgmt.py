"""Archived status, space preferences (status flow, custom fields), bulk task updates and People."""

from datetime import date

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

import database
import main
import spaces
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
            "status_flow": {"todo": {"in_progress": False, "archived": True}, "done": {}},
            "custom_fields_schema": [
                {"id": "hull", "name": " Hull no. ", "type": "text", "options": ["ignored"]},
                {"id": "weight", "name": "Weight", "type": "number"},
                {"id": "yard", "name": "Yard", "type": "dropdown", "options": [" North ", "South", "North", ""]},
            ],
        },
    )

    assert response.status_code == 200, response.text
    space = response.json()
    assert space["name"] == "Default"  # unsent fields are kept
    flow = {"todo": {"in_progress": False, "archived": True}, "done": {}}
    assert space["status_flow"] == flow
    assert space["custom_fields_schema"] == [
        {"id": "hull", "name": "Hull no.", "type": "text", "options": [], "colors": {}, "show_inline": False},
        {"id": "weight", "name": "Weight", "type": "number", "options": [], "colors": {}, "show_inline": False},
        {"id": "yard", "name": "Yard", "type": "dropdown", "options": ["North", "South"], "colors": {}, "show_inline": False},
    ]
    assert client.get("/api/spaces").json()[0]["status_flow"] == flow

    # Renaming keeps the preferences; a null flow allows every move again.
    assert client.put("/api/spaces/1", json={"name": "Work"}).json()["custom_fields_schema"][0]["id"] == "hull"
    assert client.put("/api/spaces/1", json={"status_flow": None}).json()["status_flow"] is None
    assert client.put("/api/spaces/1", json={"status_flow": {}}).json()["status_flow"] is None


def test_space_status_colors(client):
    assert client.get("/api/spaces").json()[0]["status_colors"] == {}

    response = client.put("/api/spaces/1", json={"status_colors": {"done": "#0F0", "blocked": "#ef4444", "todo": ""}})

    assert response.status_code == 200, response.text
    colors = {"done": "#00ff00", "blocked": "#ef4444"}  # normalised; a blank colour falls back to the default
    assert response.json()["status_colors"] == colors
    assert client.get("/api/spaces").json()[0]["status_colors"] == colors
    assert client.put("/api/spaces/1", json={"name": "Work"}).json()["status_colors"] == colors
    assert client.put("/api/spaces/1", json={"status_colors": None}).json()["status_colors"] == {}


def test_space_rag_folders(client):
    assert client.get("/api/spaces").json()[0]["rag_folders"] == []

    response = client.put("/api/spaces/1", json={"rag_folders": [r" O:\Lawrences Files ", "", r"Y:\Shared", r"Y:\Shared"]})

    assert response.status_code == 200, response.text
    folders = [r"O:\Lawrences Files", r"Y:\Shared"]  # stripped, without blanks or repeats
    assert response.json()["rag_folders"] == folders
    assert client.get("/api/spaces").json()[0]["rag_folders"] == folders
    assert client.put("/api/spaces/1", json={"name": "Work"}).json()["rag_folders"] == folders
    assert client.put("/api/spaces/1", json={"rag_folders": None}).json()["rag_folders"] == []


@pytest.mark.parametrize(
    "payload",
    [
        {"name": None},
        {"status_flow": {"todo": {"nope": False}}},
        {"status_flow": {"nope": {"todo": False}}},
        {"status_flow": {"todo": {"done": "maybe"}}},
        {"status_colors": {"nope": "#ffffff"}},
        {"status_colors": {"done": "green"}},
        {"status_colors": ["#ffffff"]},
        {"custom_fields_schema": [{"id": "Has Spaces", "name": "x"}]},
        {"custom_fields_schema": [{"id": "a", "name": "A"}, {"id": "a", "name": "B"}]},
        {"custom_fields_schema": [{"id": "a", "name": "A", "type": "colour"}]},
        {"custom_fields_schema": [{"id": "a", "name": " "}]},
        {"custom_fields_schema": [{"id": "a", "name": "A", "type": "dropdown"}]},
        {"custom_fields_schema": [{"id": "a", "name": "A", "type": "dropdown", "options": [" "]}]},
        {"custom_fields_schema": [{"id": "a", "name": "A", "type": "dropdown", "options": ["x" * 129]}]},
    ],
)
def test_space_preferences_validation(client, payload):
    assert client.put("/api/spaces/1", json=payload).status_code == 422


def test_stored_status_flow_is_cleaned():
    flow = clean_status_flow({"todo": {"in_progress": True, "nope": False}, "done": {}, "bad": {"todo": True}})
    assert flow == {Status.DONE: {}}  # targets with an unknown status are dropped whole
    assert clean_status_flow({"todo": {"in_progress": True}}) == {Status.TODO: {Status.IN_PROGRESS: True}}
    # Flows saved before the comment flag: lists of allowed moves, none of which ask for a comment.
    assert clean_status_flow({"todo": ["in_progress", "in_progress"], "done": []}) == {
        Status.TODO: {Status.IN_PROGRESS: False},
        Status.DONE: {},
    }
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
                {"id": "yard", "name": "Yard", "type": "dropdown", "options": ["North", "South"]},
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


def test_dropdown_field_takes_one_of_its_options(client, custom_fields):
    task = new_task(client, "Keel", custom_fields={"yard": " South "})
    assert task["custom_fields"] == {"yard": "South"}
    assert client.patch(f"/api/tasks/{task['id']}", json={"custom_fields": {"yard": "East"}}).status_code == 400
    assert client.patch(f"/api/tasks/{task['id']}", json={"custom_fields": {"yard": ""}}).json()["custom_fields"] == {}


@pytest.mark.parametrize(
    "values",
    [
        {"unknown": "x"},
        {"weight": "heavy"},
        {"weight": True},
        {"survey": "next week"},
        {"signed": "yes"},
        {"hull": 12},
        {"yard": "East"},
        {"yard": 1},
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
        "is_me": False,
        "color": None,
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
        ({"space_id": 1, "name": "x" * 65}, 422),  # longer than a task's assignee
        ({"space_id": 1, "name": "X", "email": "not-an-email"}, 422),
        ({"space_id": 1, "name": "X", "avatar_url": "javascript:alert(1)"}, 422),
        ({"space_id": 1, "name": "X", "color": "red"}, 422),
        ({"space_id": 1, "name": "X", "color": "#12345g"}, 422),
        ({"space_id": 99, "name": "X"}, 404),
    ],
)
def test_create_person_validation(client, payload, status):
    assert client.post("/api/people", json=payload).status_code == status


def test_only_one_person_per_space_is_me(client):
    other = client.post("/api/spaces", json={"name": "Private"}).json()["id"]
    zoe = client.post("/api/people", json={"space_id": 1, "name": "Zoe", "is_me": True}).json()
    elsewhere = client.post("/api/people", json={"space_id": other, "name": "Elsewhere", "is_me": True}).json()
    sam = client.post("/api/people", json={"space_id": 1, "name": "Sam"}).json()

    def me(space_id):
        return [p["name"] for p in client.get("/api/people", params={"space_id": space_id}).json() if p["is_me"]]

    assert (me(1), me(other)) == (["Zoe"], ["Elsewhere"])
    client.put(f"/api/people/{sam['id']}", json={"space_id": 1, "name": "Sam", "is_me": True})
    assert (me(1), me(other)) == (["Sam"], ["Elsewhere"])  # other spaces keep their "me"
    client.post("/api/people", json={"space_id": 1, "name": "Ana", "is_me": True})
    assert me(1) == ["Ana"]
    client.put(f"/api/people/{elsewhere['id']}", json={"space_id": other, "name": "Elsewhere"})
    assert me(other) == []
    assert client.get(f"/api/people/{zoe['id']}").json()["is_me"] is False


# --- Dropdown colours and editing custom fields --------------------------------------


def test_dropdown_colors_are_cleaned(client):
    response = client.put(
        "/api/spaces/1",
        json={
            "custom_fields_schema": [
                {
                    "id": "yard",
                    "name": "Yard",
                    "type": "dropdown",
                    "options": ["North", "South", "East"],
                    # Short hex is expanded; blanks and options the field doesn't have are dropped.
                    "colors": {" North ": "#3B82F6", "South": "#f00", "East": "", "West": "#00ff00"},
                },
                {"id": "hull", "name": "Hull", "type": "text", "colors": {"x": "#ffffff"}},
            ]
        },
    )

    assert response.status_code == 200, response.text
    yard, hull = response.json()["custom_fields_schema"]
    assert yard["colors"] == {"North": "#3b82f6", "South": "#ff0000"}
    assert hull["colors"] == {}


@pytest.mark.parametrize("color", ["blue", "#12345", "#gggggg", 12])
def test_dropdown_colors_must_be_hex(client, color):
    field = {"id": "yard", "name": "Yard", "type": "dropdown", "options": ["North"], "colors": {"North": color}}
    assert client.put("/api/spaces/1", json={"custom_fields_schema": [field]}).status_code == 422


def test_editing_custom_fields_keeps_task_values(client, custom_fields):
    task = new_task(
        client, "Keel", custom_fields={"hull": "H-12", "weight": 4.5, "signed": True, "yard": "North", "survey": "2026-11-01"}
    )
    with database.SessionLocal() as db:
        # A value of a field the space never had (e.g. imported) is left alone.
        row = db.get(Task, task["id"])
        row.custom_fields = {**row.custom_fields, "legacy": "x"}
        db.commit()

    response = client.put(
        "/api/spaces/1",
        json={
            "custom_fields_schema": [
                {"id": "hull", "name": "Hull number", "type": "text"},  # renamed: kept
                {"id": "weight", "name": "Weight", "type": "text"},  # 4.5 isn't text: cleared
                {"id": "survey", "name": "Survey", "type": "text"},  # "2026-11-01" is text: kept
                {"id": "yard", "name": "Yard", "type": "dropdown", "options": ["Northern", "South"]},
                # "signed" was deleted: its values go
            ],
            "renamed_options": {"yard": {"North": "Northern"}},
        },
    )

    assert response.status_code == 200, response.text
    assert client.get(f"/api/tasks/{task['id']}").json()["custom_fields"] == {
        "hull": "H-12",
        "survey": "2026-11-01",
        "yard": "Northern",
        "legacy": "x",
    }


def test_removed_dropdown_option_is_kept_without_a_rename(client, custom_fields):
    task = new_task(client, "Keel", custom_fields={"yard": "North"})
    client.put(
        "/api/spaces/1",
        json={"custom_fields_schema": [{"id": "yard", "name": "Yard", "type": "dropdown", "options": ["South"]}]},
    )
    assert client.get(f"/api/tasks/{task['id']}").json()["custom_fields"] == {"yard": "North"}


def test_custom_field_show_inline_is_saved(client):
    response = client.put(
        "/api/spaces/1",
        json={
            "custom_fields_schema": [
                {"id": "hull", "name": "Hull", "type": "text", "show_inline": True},
                {"id": "yard", "name": "Yard", "type": "dropdown", "options": ["North"]},
            ]
        },
    )

    assert response.status_code == 200, response.text
    hull, yard = client.get("/api/spaces").json()[0]["custom_fields_schema"]
    assert hull["show_inline"] is True
    assert yard["show_inline"] is False  # off unless asked for


# --- Project colours ----------------------------------------------------------------


def test_project_color_shows_on_projects_tasks_and_gantt(client):
    with database.SessionLocal() as db:
        project = Project(code="C7801", name="Keel")
        db.add(project)
        db.flush()
        db.add(Task(space_id=1, project_id=project.id, title="Weld", is_gantt_task=True, custom_fields={"yard": "North"}))
        db.commit()
        project_id = project.id

    response = client.put(f"/api/projects/{project_id}", json={"color": "#10B981"})
    assert response.status_code == 200, response.text
    assert (response.json()["name"], response.json()["color"]) == ("Keel", "#10b981")

    assert client.get("/api/projects").json()[0]["color"] == "#10b981"
    assert client.get("/api/tasks").json()[0]["project_color"] == "#10b981"
    gantt = client.get("/api/gantt").json()["projects"][0]
    assert gantt["color"] == "#10b981"
    assert gantt["tasks"][0]["custom_fields"] == {"yard": "North"}

    renamed = client.put(f"/api/projects/{project_id}", json={"name": " Keel build ", "color": None}).json()
    assert (renamed["name"], renamed["color"]) == ("Keel build", None)


def test_renaming_a_project_renames_its_code_and_tag(client):
    root = spaces.content_dir(spaces.DEFAULT_SPACE_ID)
    (root / "Keel").mkdir(parents=True)
    (root / "Keel" / "plan.md").write_text("---\ntags: [c7801, urgent]\n---\nBody\n", encoding="utf-8")
    (root / "Keel" / "single.md").write_text("---\ntags: C7801\n---\nBody\n", encoding="utf-8")
    (root / "Keel" / "other.md").write_text("---\ntags: [urgent]\n---\nBody\n", encoding="utf-8")
    with database.SessionLocal() as db:
        project = Project(code="C7801", name="Keel")
        db.add(project)
        db.commit()
        project_id = project.id
    tagged = new_task(client, "Weld", tags=["C7801", "Hull build", "urgent"])
    untagged = new_task(client, "Paint", tags=["urgent"])

    response = client.put(f"/api/projects/{project_id}", json={"name": "Hull build"})

    assert response.status_code == 200, response.text
    assert response.json()["code"] == "Hull build"
    assert client.get(f"/api/tasks/{tagged['id']}").json()["tags"] == ["Hull build", "urgent"]
    assert client.get(f"/api/tasks/{untagged['id']}").json()["tags"] == ["urgent"]
    notes = {
        name: client.get("/api/notes/file", params={"path": f"Keel/{name}.md"}).json()["frontmatter"]["tags"]
        for name in ("plan", "single", "other")
    }
    assert notes == {"plan": ["Hull build", "urgent"], "single": ["Hull build"], "other": ["urgent"]}


def test_renaming_a_project_keeps_codes_unique(client):
    with database.SessionLocal() as db:
        db.add(Project(code="HULL", name="Hull"))
        project = Project(code="C7801", name="Keel")
        db.add(project)
        db.commit()
        project_id = project.id

    response = client.put(f"/api/projects/{project_id}", json={"name": "hull"})
    assert response.status_code == 400
    assert sorted(p["code"] for p in client.get("/api/projects").json()) == ["C7801", "HULL"]
    # Only the case of its own code changes: no collision with itself.
    assert client.put(f"/api/projects/{project_id}", json={"name": "c7801"}).json()["code"] == "c7801"
    long_name = "x" * 40
    assert client.put(f"/api/projects/{project_id}", json={"name": long_name}).json()["code"] == "x" * 32


@pytest.mark.parametrize(
    "payload, status",
    [({"color": "red"}, 422), ({"name": " "}, 422), ({"description": None}, 422)],
)
def test_project_update_validation(client, payload, status):
    with database.SessionLocal() as db:
        project = Project(code="C7801", name="Keel")
        db.add(project)
        db.commit()
        project_id = project.id
    assert client.put(f"/api/projects/{project_id}", json=payload).status_code == status
    assert client.put("/api/projects/999", json={"color": "#ffffff"}).status_code == 404


# --- Advanced filters ---------------------------------------------------------------


def test_custom_field_filters(client, custom_fields):
    new_task(client, "A", custom_fields={"hull": "H-12", "weight": 4.5, "signed": True, "yard": "North"})
    new_task(client, "B", custom_fields={"hull": "h-120", "weight": 4, "yard": "South"})
    new_task(client, "C")

    def cf(*filters):
        return titles(client, cf=list(filters))

    assert cf("yard:North") == ["A"]
    assert cf("yard:") == ["C"]
    assert cf("yard:*") == ["A", "B"]
    assert cf("hull:h-12") == ["A", "B"]  # text: case-insensitive, anywhere in the value
    assert cf("weight:4.0") == ["B"]
    assert cf("signed:true") == ["A"]
    assert cf("signed:false") == ["B", "C"]  # unticked counts as false
    assert cf("hull:h-12", "yard:South") == ["B"]
    assert cf("gone:x") == ["A", "B", "C"]  # fields the space doesn't have are ignored
    assert client.get("/api/tasks", params={"cf": "no-colon"}).status_code == 400


def test_date_filters(client):
    new_task(client, "Due soon", deadline="2026-10-10", start_date="2026-10-01")
    new_task(client, "Due later", deadline="2026-12-01")
    new_task(client, "Undated")

    assert titles(client, has_deadline=True) == ["Due soon", "Due later"]
    assert titles(client, has_deadline=False) == ["Undated"]
    assert titles(client, has_start_date=True) == ["Due soon"]
    assert titles(client, has_start_date=False) == ["Due later", "Undated"]
    assert titles(client, due_after="2026-10-10") == ["Due soon", "Due later"]
    assert titles(client, due_after="2026-10-11") == ["Due later"]
    assert titles(client, due_before="2026-10-10") == ["Due soon"]
    assert titles(client, due_after="2026-10-01", due_before="2026-11-30") == ["Due soon"]
    assert titles(client, start_after="2026-10-01") == ["Due soon"]
    assert titles(client, start_after="2026-10-02") == []
    assert titles(client, start_before="2026-10-01") == ["Due soon"]
    assert titles(client, start_before="2026-09-30") == []


def test_field_filters(client):
    note = spaces.content_dir(1) / "Projects" / "Keel.md"
    note.parent.mkdir(parents=True, exist_ok=True)
    note.write_text("# Keel", encoding="utf-8")
    weld = new_task(client, "Weld", priority="urgent", status="in_progress", deadline="2026-10-10")
    launch = new_task(client, "Launch", priority="high", deadline="2026-11-01", note_path="Projects/Keel.md")
    with database.SessionLocal() as db:
        # Gantt tasks and milestones come from the Gantt import, not the API.
        db.get(Task, weld["id"]).is_gantt_task = True
        db.get(Task, launch["id"]).is_milestone = True
        db.commit()
    new_task(client, "Paint")
    new_task(client, "Old", status="archived")

    assert titles(client, priority="urgent") == ["Weld"]
    assert titles(client, priority="normal") == ["Paint"]
    assert titles(client, status="in_progress") == ["Weld"]
    assert titles(client, status="archived") == ["Old"]
    assert titles(client, is_gantt_task=True) == ["Weld"]
    assert titles(client, is_gantt_task=False) == ["Launch", "Paint"]
    assert titles(client, is_milestone=True) == ["Launch"]
    assert titles(client, is_milestone=False) == ["Weld", "Paint"]
    assert titles(client, has_note=True) == ["Launch"]
    assert titles(client, has_note=False) == ["Weld", "Paint"]
    assert titles(client, priority="high", is_milestone=True, has_note=True) == ["Launch"]
    assert client.get("/api/tasks", params={"priority": "whenever"}).status_code == 422
    assert titles(client, priority=["urgent", "high"]) == ["Weld", "Launch"]
    assert titles(client, status=["in_progress", "archived"]) == ["Weld", "Old"]
    assert client.get("/api/tasks", params={"status": ["todo", "whenever"]}).status_code == 422


def test_multi_value_project_and_assignee_filters(client):
    with database.SessionLocal() as db:
        db.add_all([Project(code="C7801", name="Hull"), Project(code="C7802", name="Deck"), Project(code="C7803", name="Rig")])
        db.commit()
        hull, deck, rig = db.scalars(select(Project.id).order_by(Project.id)).all()
    new_task(client, "Keel", project_id=hull, assignee="Jose")
    new_task(client, "Hatch", project_id=deck, assignee="Ana")
    new_task(client, "Mast", project_id=rig)

    assert titles(client, project_id=[hull, deck]) == ["Keel", "Hatch"]
    assert titles(client, project_id=rig) == ["Mast"]
    assert titles(client, assignee=["Jose", "Ana"]) == ["Keel", "Hatch"]
    assert titles(client, assignee=["Ana", ""]) == ["Hatch", "Mast"]
    assert titles(client, assignee="") == ["Mast"]


def test_saved_view_keeps_advanced_filters(client):
    filters = {
        "custom_fields": {"yard": "North", "signed": True, "weight": 4.5, "gone": None},
        "has_deadline": True,
        "has_start_date": False,
        "due_after": "2026-10-01",
        "due_before": "2026-10-31",
        "priority": "high",
        "status": "blocked",
        "is_gantt_task": True,
        "is_milestone": False,
        "has_note": True,
        "start_after": "2026-09-01",
        "start_before": "2026-09-30",
        "gantt_color_by": "yard",
    }
    view = client.post("/api/views", json={"space_id": 1, "name": "North yard", "view_type": "list", "filters": filters})
    assert view.status_code == 201, view.text
    saved = view.json()["filters"]
    assert saved["custom_fields"] == {"yard": "North", "signed": "true", "weight": "4.5"}
    assert (saved["has_deadline"], saved["has_start_date"]) == (True, False)
    assert (saved["due_after"], saved["due_before"]) == ("2026-10-01", "2026-10-31")
    assert (saved["priority"], saved["status"]) == (["high"], ["blocked"])
    assert (saved["is_gantt_task"], saved["is_milestone"], saved["has_note"]) == (True, False, True)
    assert (saved["start_after"], saved["start_before"]) == ("2026-09-01", "2026-09-30")
    assert saved["gantt_color_by"] == "yard"


def test_person_avatar_color(client):
    person = client.post("/api/people", json={"space_id": 1, "name": "Zoe", "color": "#3B82F6"}).json()
    assert person["color"] == "#3b82f6"
    updated = client.put(f"/api/people/{person['id']}", json={"space_id": 1, "name": "Zoe", "color": "#f0a"}).json()
    assert updated["color"] == "#ff00aa"
    cleared = client.put(f"/api/people/{person['id']}", json={"space_id": 1, "name": "Zoe", "color": ""}).json()
    assert cleared["color"] is None
    assert client.get(f"/api/people/{person['id']}").json()["color"] is None


# --- Multiple assignees and tags (phase 17) ------------------------------------------


def test_create_task_with_several_assignees_keeps_assignee_in_sync(client):
    task = new_task(client, "Fair", assignees=[" Ana ", "Bo", "", "Ana"])

    assert task["assignees"] == ["Ana", "Bo"]
    assert task["assignee"] == "Ana"


def test_create_task_with_only_assignee_fills_assignees(client):
    task = new_task(client, "Solo", assignee="Ana")

    assert task["assignee"] == "Ana"
    assert task["assignees"] == ["Ana"]
    assert new_task(client, "Nobody")["assignees"] == []


def test_patch_assignees_replaces_everyone_and_syncs_assignee(client):
    task = new_task(client, "Rig", assignee="Ana")

    response = client.patch(f"/api/tasks/{task['id']}", json={"assignees": ["Bo", "Cy"]})
    assert response.status_code == 200, response.text
    assert response.json()["assignees"] == ["Bo", "Cy"]
    assert response.json()["assignee"] == "Bo"

    item = client.get(f"/api/tasks/{task['id']}").json()
    assert (item["assignee"], item["assignees"]) == ("Bo", ["Bo", "Cy"])

    cleared = client.patch(f"/api/tasks/{task['id']}", json={"assignees": []}).json()
    assert (cleared["assignee"], cleared["assignees"]) == (None, [])


def test_patch_assignee_alone_makes_that_person_the_only_assignee(client):
    task = new_task(client, "Rig", assignees=["Ana", "Bo"])

    patched = client.patch(f"/api/tasks/{task['id']}", json={"assignee": "Cy"}).json()
    assert (patched["assignee"], patched["assignees"]) == ("Cy", ["Cy"])

    unclaimed = client.patch(f"/api/tasks/{task['id']}", json={"assignee": None}).json()
    assert (unclaimed["assignee"], unclaimed["assignees"]) == (None, [])


def test_patch_other_fields_leaves_assignees_alone(client):
    task = new_task(client, "Rig", assignees=["Ana", "Bo"])

    patched = client.patch(f"/api/tasks/{task['id']}", json={"title": "Rigging"}).json()
    assert patched["assignees"] == ["Ana", "Bo"]


def test_assignee_names_are_limited_in_length(client):
    response = client.post("/api/tasks", json={"space_id": 1, "title": "Long", "assignees": ["x" * 65]})
    assert response.status_code == 422


def test_legacy_rows_with_only_assignee_list_that_assignee(client):
    with database.SessionLocal() as db:
        task = Task(space_id=1, title="Old", assignee="Ana", assignees=None)
        db.add(task)
        db.commit()
        task_id = task.id

    item = client.get(f"/api/tasks/{task_id}").json()
    assert item["assignees"] == ["Ana"]
    assert titles(client, assignee="Ana") == ["Old"]


def test_assignee_filter_matches_any_of_the_assignees(client):
    new_task(client, "Both", assignees=["Ana", "Bo"])
    new_task(client, "Bo only", assignees=["Bo"])
    new_task(client, "Nobody")

    assert titles(client, assignee="Ana") == ["Both"]
    assert sorted(titles(client, assignee="Bo")) == ["Bo only", "Both"]
    assert titles(client, assignee="") == ["Nobody"]
    assert sorted(titles(client, assignee=["Ana", ""])) == ["Both", "Nobody"]


def test_bulk_update_sets_assignees_and_tags(client):
    first = new_task(client, "One", tags=["old"])
    second = new_task(client, "Two")

    response = client.post(
        "/api/tasks/bulk-update",
        json={"task_ids": [first["id"], second["id"]], "updates": {"assignees": ["Ana", "Bo"], "tags": ["rig"]}},
    )
    assert response.status_code == 200, response.text
    for item in response.json():
        assert item["assignees"] == ["Ana", "Bo"]
        assert item["assignee"] == "Ana"
        assert item["tags"] == ["rig"]


def test_task_tags_can_be_added_and_removed_and_are_suggested(client):
    task = new_task(client, "Tagged")

    added = client.patch(f"/api/tasks/{task['id']}", json={"tags": ["welding", " client ", "welding"]}).json()
    assert added["tags"] == ["welding", "client"]
    assert {"welding", "client"} <= set(client.get("/api/spaces/1/tags").json())

    removed = client.patch(f"/api/tasks/{task['id']}", json={"tags": ["client"]}).json()
    assert removed["tags"] == ["client"]
    assert titles(client, tag="client") == ["Tagged"]
    assert titles(client, tag="welding") == []
