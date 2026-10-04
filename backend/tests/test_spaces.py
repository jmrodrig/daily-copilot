import json
from datetime import date
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

import agent
import database
import file_layer
import main
import spaces
from config import Settings
from models import FolderMeta, HistoryRecord, Project, Space, Task
from schemas import AccessMode, ChatMessage, Status


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setattr(main, "init_db", lambda: None)
    with TestClient(main.app) as client:
        yield client


def write(space_id, path, text):
    file = spaces.content_dir(space_id) / path
    file.parent.mkdir(parents=True, exist_ok=True)
    file.write_text(text, encoding="utf-8")


def flag(space_id, path, **flags):
    """Set folder flags directly: the API only marks top-level folders, but moved folders keep theirs."""
    with database.SessionLocal() as db:
        return spaces.set_folder_meta(db, space_id, path, **flags).project_id


# --- Startup migration ----------------------------------------------------------


def test_migrate_moves_legacy_notes_into_default_space(data_dirs):
    legacy = data_dirs.notes_dir
    (legacy / "C7801" / "Notes-in").mkdir(parents=True)
    (legacy / "C7801" / "Notes-in" / "a.md").write_text("keel", encoding="utf-8")
    with database.SessionLocal() as db:
        db.add(Task(title="Old task"))
        db.commit()

        spaces.migrate(db)
        spaces.migrate(db)  # idempotent

        assert [(s.id, s.name) for s in db.scalars(select(Space))] == [(1, "Default")]
        assert db.scalars(select(Task)).one().space_id == 1
    assert not legacy.exists()
    assert (spaces.content_dir(1) / "C7801" / "Notes-in" / "a.md").read_text(encoding="utf-8") == "keel"
    assert sorted(p.name for p in spaces.templates_dir(1).iterdir()) == ["Design decision.md", "Meeting note.md"]


def test_migrate_never_merges_into_existing_content(data_dirs):
    (data_dirs.notes_dir).mkdir()
    (data_dirs.notes_dir / "old.md").write_text("old", encoding="utf-8")
    write(1, "new.md", "new")
    with database.SessionLocal() as db:
        spaces.migrate(db)
    assert (data_dirs.notes_dir / "old.md").exists()
    assert not (spaces.content_dir(1) / "old.md").exists()


# --- Spaces and the content tree ------------------------------------------------


def test_spaces_list_and_create(client):
    assert client.get("/api/spaces").json()[0] | {"created_at": None} == {"id": 1, "name": "Default", "created_at": None}

    response = client.post("/api/spaces", json={"name": "  Private "})

    assert response.status_code == 201
    space = response.json()
    assert space["name"] == "Private"
    assert spaces.content_dir(space["id"]).is_dir()
    templates = client.get("/api/tree", params={"space_id": space["id"]}).json()["templates"]
    assert [t["title"] for t in templates] == ["Design decision", "Meeting note"]
    assert client.post("/api/spaces", json={"name": " "}).status_code == 422
    assert client.get("/api/tree", params={"space_id": 99}).status_code == 404


def test_tree_nests_folders_and_flags(client):
    write(1, "Yachts/C7801/Design/Keel.md", "---\ntitle: Keel design\n---\nBody")
    write(1, "Yachts/C7801/plan.md", "# Build plan\n")
    write(1, "Standards/ISO.md", "ISO 12215")
    write(1, ".trash/old.md", "old")
    (spaces.content_dir(1) / "Empty").mkdir()
    flag(1, "Yachts/C7801", is_project=True)
    client.put("/api/folders/meta", json={"space_id": 1, "path": "Standards", "is_reference": True})

    tree = client.get("/api/tree", params={"space_id": 1}).json()

    root = tree["content"]
    assert [f["name"] for f in root["folders"]] == ["Empty", "Standards", "Yachts"]
    standards = root["folders"][1]
    assert standards["is_reference"] and not standards["is_project"]
    c7801 = root["folders"][2]["folders"][0]
    assert (c7801["path"], c7801["is_project"]) == ("Yachts/C7801", True)
    assert c7801["project_id"] is not None
    assert c7801["notes"] == [{"path": "Yachts/C7801/plan.md", "title": "Build plan"}]
    assert c7801["folders"][0]["notes"] == [{"path": "Yachts/C7801/Design/Keel.md", "title": "Keel design"}]
    assert {t["path"] for t in tree["templates"]} == {"Meeting note.md", "Design decision.md"}


def test_marking_a_project_folder_links_the_gantt_project(client):
    with database.SessionLocal() as db:
        gantt = Project(code="C7801", name="Spirit 111")
        db.add(gantt)
        db.commit()
    (spaces.content_dir(1) / "C7801").mkdir(parents=True)
    (spaces.content_dir(1) / "Other" / "C7801").mkdir(parents=True)

    first = client.put("/api/folders/meta", json={"space_id": 1, "path": "/C7801/", "is_project": True}).json()
    # A second folder with the same name gets its own project.
    second_id = flag(1, "Other/C7801", is_project=True)
    unmarked = client.put("/api/folders/meta", json={"space_id": 1, "path": "C7801", "is_project": False}).json()
    remarked = client.put("/api/folders/meta", json={"space_id": 1, "path": "C7801", "is_project": True}).json()

    assert first == {"space_id": 1, "path": "C7801", "is_project": True, "is_reference": False, "project_id": gantt.id}
    assert second_id not in (None, gantt.id)
    assert unmarked["project_id"] is None
    assert remarked["project_id"] == gantt.id
    with database.SessionLocal() as db:
        assert db.get(Project, second_id).code == "C7801-2"
        assert db.scalars(select(HistoryRecord).where(HistoryRecord.entity_type == "FolderMeta")).first() is not None


def test_folder_meta_errors(client):
    assert client.put("/api/folders/meta", json={"space_id": 1, "path": "Nope", "is_project": True}).status_code == 404
    assert client.put("/api/folders/meta", json={"space_id": 1, "path": "../x", "is_project": True}).status_code == 400
    assert client.put("/api/folders/meta", json={"space_id": 9, "path": "x", "is_project": True}).status_code == 404


def test_only_top_level_folders_can_be_marked(client):
    (spaces.content_dir(1) / "Yachts" / "C7801").mkdir(parents=True)
    flag(1, "Yachts/C7801", is_reference=True)

    for flags in ({"is_project": True}, {"is_reference": True}, {"is_project": True, "is_reference": False}):
        response = client.put("/api/folders/meta", json={"space_id": 1, "path": "Yachts/C7801", **flags})
        assert response.status_code == 400
        assert "top-level" in response.json()["detail"]
    # A sub-folder can still lose a flag it kept from being moved.
    unmarked = client.put("/api/folders/meta", json={"space_id": 1, "path": "Yachts/C7801", "is_reference": False})
    assert unmarked.status_code == 200
    assert not unmarked.json()["is_reference"]
    assert client.put("/api/folders/meta", json={"space_id": 1, "path": "/Yachts/", "is_project": True}).status_code == 200


def test_create_folder_and_note_from_template(client, monkeypatch):
    monkeypatch.setattr(main, "_today", lambda: date(2026, 10, 4))

    assert client.post("/api/folders", json={"space_id": 1, "path": "C7801/Meetings"}).status_code == 201
    assert client.post("/api/folders", json={"space_id": 1, "path": "C7801/Meetings"}).status_code == 409
    assert client.post("/api/folders", json={"space_id": 1, "path": "../out"}).status_code == 400

    response = client.post(
        "/api/notes",
        json={"space_id": 1, "path": "C7801/Meetings/Weekly", "template": "Meeting note.md", "title": "Weekly 1"},
    )

    assert response.status_code == 201
    note = response.json()
    assert note["path"] == "C7801/Meetings/Weekly.md"
    assert note["frontmatter"] == {"type": "meeting", "created": "2026-10-04", "state": "draft"}
    assert note["content"].startswith("# Weekly 1\n")
    assert file_layer.read_note(note["path"], notes_dir=spaces.content_dir(1))["content"] == note["content"]
    assert client.post("/api/notes", json={"space_id": 1, "path": "C7801/Meetings/Weekly.md"}).status_code == 409
    assert client.post("/api/notes", json={"space_id": 1, "path": "x", "template": "missing.md"}).status_code == 404

    plain = client.post("/api/notes", json={"space_id": 1, "path": "Inbox/Idea.md"}).json()
    assert plain["content"] == "# Idea\n"
    with database.SessionLocal() as db:
        record = db.scalars(select(HistoryRecord).where(HistoryRecord.entity_id == "Inbox/Idea.md")).one()
    assert record.source == "desktop"

    template = client.get("/api/notes/file", params={"space_id": 1, "path": "Meeting note.md", "root": "templates"})
    assert template.json()["frontmatter"] == {"type": "meeting"}


def test_update_note_saves_the_body_and_state(client):
    write(1, "C7801/Keel.md", "---\ncreated: 2026-09-30\ntitle: Keel\n---\nOld body\n")
    root = spaces.content_dir(1)

    edited = client.put("/api/notes/file", json={"space_id": 1, "path": "C7801/Keel.md", "content": "New body\n"})
    assert edited.status_code == 200
    assert edited.json() == {
        "path": "C7801/Keel.md",
        "frontmatter": {"created": "2026-09-30", "title": "Keel"},
        "content": "New body\n",
    }

    published = client.put("/api/notes/file", json={"space_id": 1, "path": "C7801/Keel.md", "state": "published"})
    assert published.json()["frontmatter"]["state"] == "published"
    note = file_layer.read_note("C7801/Keel.md", notes_dir=root)
    # Untouched front-matter keeps its YAML types (the date stays a date).
    assert note["frontmatter"] == {"created": date(2026, 9, 30), "title": "Keel", "state": "published"}
    assert note["content"] == "New body\n"

    both = client.put(
        "/api/notes/file", json={"space_id": 1, "path": "C7801/Keel.md", "content": "Draft\n", "state": "draft"}
    ).json()
    assert (both["frontmatter"]["state"], both["content"]) == ("draft", "Draft\n")
    with database.SessionLocal() as db:
        records = db.scalars(select(HistoryRecord).where(HistoryRecord.entity_id == "C7801/Keel.md")).all()
    assert {r.source for r in records} == {"desktop"}


@pytest.mark.parametrize(
    ("payload", "status"),
    [
        ({"path": "missing.md", "content": "x"}, 404),
        ({"path": "../x.md", "content": "x"}, 400),
        ({"path": ".trash/old.md", "content": "x"}, 400),
        ({"path": "a.md", "state": "archived"}, 422),
        ({"path": "a.md", "space_id": 9, "content": "x"}, 404),
    ],
)
def test_update_note_errors(client, payload, status):
    write(1, "a.md", "a")
    write(1, ".trash/old.md", "old")
    assert client.put("/api/notes/file", json={"space_id": 1, **payload}).status_code == status


def test_notes_are_isolated_per_space(client):
    other = client.post("/api/spaces", json={"name": "Private"}).json()["id"]
    write(1, "work.md", "work")
    write(other, "home.md", "home")

    assert [n["path"] for n in client.get("/api/notes", params={"space_id": 1}).json()] == ["work.md"]
    assert [n["path"] for n in client.get("/api/notes", params={"space_id": other}).json()] == ["home.md"]
    assert client.get("/api/notes/file", params={"space_id": other, "path": "work.md"}).status_code == 404


# --- Organizing content (Phase 9.2) ------------------------------------------------


def note_history(entity_id):
    with database.SessionLocal() as db:
        return [
            (r.action, r.snapshot.get("previous_path"), r.snapshot.get("copied_from"))
            for r in db.scalars(select(HistoryRecord).where(HistoryRecord.entity_id == entity_id))
        ]


def test_move_a_note_into_a_folder(client):
    write(1, "Idea.md", "# Idea\n")
    (spaces.content_dir(1) / "Inbox").mkdir()

    moved = client.post("/api/content/move", json={"space_id": 1, "path": "Idea.md", "destination": "Inbox"})

    assert moved.json() == {"kind": "note", "path": "Inbox/Idea.md"}
    assert (spaces.content_dir(1) / "Inbox" / "Idea.md").read_text(encoding="utf-8") == "# Idea\n"
    assert not (spaces.content_dir(1) / "Idea.md").exists()
    assert note_history("Inbox/Idea.md") == [("rename", "Idea.md", None)]
    back = client.post("/api/content/move", json={"space_id": 1, "path": "Inbox/Idea.md", "destination": ""})
    assert back.json() == {"kind": "note", "path": "Idea.md"}


def test_move_a_project_folder_keeps_its_flags_and_task_links(client):
    write(1, "C7801/Keel/Drawings.md", "keel")
    (spaces.content_dir(1) / "Yachts").mkdir()
    project_id = client.put("/api/folders/meta", json={"space_id": 1, "path": "C7801", "is_project": True}).json()[
        "project_id"
    ]
    flag(1, "C7801/Keel", is_reference=True)
    task = client.post(
        "/api/tasks", json={"space_id": 1, "title": "Check", "note_paths": ["C7801/Keel/Drawings.md"]}
    ).json()

    moved = client.post("/api/content/move", json={"space_id": 1, "path": "C7801", "destination": "Yachts"})

    assert moved.json() == {"kind": "folder", "path": "Yachts/C7801"}
    tree = client.get("/api/tree", params={"space_id": 1}).json()["content"]
    folder = tree["folders"][0]["folders"][0]
    assert (folder["path"], folder["is_project"], folder["project_id"]) == ("Yachts/C7801", True, project_id)
    assert folder["folders"][0]["is_reference"]
    assert client.get(f"/api/tasks/{task['id']}").json()["note_paths"] == ["Yachts/C7801/Keel/Drawings.md"]
    assert note_history("Yachts/C7801/Keel/Drawings.md") == [("rename", "C7801/Keel/Drawings.md", None)]


@pytest.mark.parametrize(
    ("payload", "status"),
    [
        ({"path": "A", "destination": "A/B"}, 400),  # into itself
        ({"path": "A", "destination": "Nope"}, 404),
        ({"path": "Missing.md", "destination": ""}, 404),
        ({"path": "../x.md", "destination": ""}, 400),
        ({"path": "A/B", "destination": "C"}, 409),  # C/B exists
    ],
)
def test_move_errors(client, payload, status):
    (spaces.content_dir(1) / "A" / "B").mkdir(parents=True)
    (spaces.content_dir(1) / "C" / "B").mkdir(parents=True)
    assert client.post("/api/content/move", json={"space_id": 1, **payload}).status_code == status
    assert (spaces.content_dir(1) / "A" / "B").is_dir()


def test_rename_a_note_retitles_it(client):
    root = spaces.content_dir(1)
    (root / "Docs").mkdir(parents=True)
    (root / "Docs" / "Plan.md").write_bytes(b"# Plan\r\n\r\nBody\r\n")
    write(1, "Docs/Titled.md", "---\ntitle: Old\n---\nBody\n")
    write(1, "Docs/Plain.md", "Just text\n")

    renamed = client.post("/api/content/rename", json={"space_id": 1, "path": "Docs/Plan.md", "name": "Roadmap"})
    client.post("/api/content/rename", json={"space_id": 1, "path": "Docs/Titled.md", "name": "New.md"})
    client.post("/api/content/rename", json={"space_id": 1, "path": "Docs/Plain.md", "name": "Other"})

    assert renamed.json() == {"kind": "note", "path": "Docs/Roadmap.md"}
    assert (root / "Docs" / "Roadmap.md").read_bytes() == b"# Roadmap\r\n\r\nBody\r\n"
    assert file_layer.read_note("Docs/New.md", notes_dir=root)["frontmatter"] == {"title": "New"}
    assert (root / "Docs" / "Other.md").read_text(encoding="utf-8") == "Just text\n"


def test_rename_a_folder_and_errors(client):
    write(1, "Old/a.md", "a")
    write(1, "Taken/b.md", "b")
    client.put("/api/folders/meta", json={"space_id": 1, "path": "Old", "is_reference": True})

    renamed = client.post("/api/content/rename", json={"space_id": 1, "path": "Old", "name": "New"})

    assert renamed.json() == {"kind": "folder", "path": "New"}
    folder = client.get("/api/tree", params={"space_id": 1}).json()["content"]["folders"][0]
    assert (folder["path"], folder["is_reference"]) == ("New", True)
    assert client.post("/api/content/rename", json={"space_id": 1, "path": "New", "name": "Taken"}).status_code == 409
    for name in ["a/b", "a\\b", ".hidden", " "]:
        assert client.post("/api/content/rename", json={"space_id": 1, "path": "New", "name": name}).status_code == 422


def test_duplicate_a_note_and_a_folder(client):
    write(1, "Docs/Plan.md", "# Plan\n")
    client.put("/api/folders/meta", json={"space_id": 1, "path": "Docs", "is_project": True})

    first = client.post("/api/content/duplicate", json={"space_id": 1, "path": "Docs/Plan.md"})
    second = client.post("/api/content/duplicate", json={"space_id": 1, "path": "Docs/Plan.md"})
    folder = client.post("/api/content/duplicate", json={"space_id": 1, "path": "Docs"})

    assert first.status_code == 201
    assert [first.json()["path"], second.json()["path"], folder.json()["path"]] == [
        "Docs/Plan (copy).md",
        "Docs/Plan (copy 2).md",
        "Docs (copy)",
    ]
    root = spaces.content_dir(1)
    assert (root / "Docs" / "Plan (copy 2).md").read_text(encoding="utf-8") == "# Plan (copy 2)\n"
    assert sorted(p.name for p in (root / "Docs (copy)").iterdir()) == ["Plan (copy 2).md", "Plan (copy).md", "Plan.md"]
    assert note_history("Docs (copy)/Plan.md") == [("create", None, "Docs/Plan.md")]
    copy = client.get("/api/tree", params={"space_id": 1}).json()["content"]["folders"][1]
    assert (copy["path"], copy["is_project"]) == ("Docs (copy)", False)


def test_delete_a_note_and_a_folder(client):
    write(1, "C7801/Keel.md", "keel")
    write(1, "Loose.md", "loose")
    client.put("/api/folders/meta", json={"space_id": 1, "path": "C7801", "is_project": True})
    task = client.post("/api/tasks", json={"space_id": 1, "title": "Check", "note_paths": ["C7801/Keel.md"]}).json()

    assert client.delete("/api/content", params={"space_id": 1, "path": "Loose.md"}).status_code == 204
    assert client.delete("/api/content", params={"space_id": 1, "path": "C7801"}).status_code == 204
    assert client.delete("/api/content", params={"space_id": 1, "path": "C7801"}).status_code == 404

    assert list(spaces.content_dir(1).iterdir()) == []
    assert note_history("C7801/Keel.md")[-1][0] == "delete"
    assert client.get(f"/api/tasks/{task['id']}").json()["note_paths"] == []
    # A new folder with the same name starts unflagged.
    (spaces.content_dir(1) / "C7801").mkdir()
    assert client.get("/api/tree", params={"space_id": 1}).json()["content"]["folders"][0]["is_project"] is False


# --- Task engine ------------------------------------------------------------------


def test_task_crud_filters_and_links(client):
    other = client.post("/api/spaces", json={"name": "Private"}).json()["id"]
    (spaces.content_dir(1) / "C7801").mkdir(parents=True)
    project_id = client.put("/api/folders/meta", json={"space_id": 1, "path": "C7801", "is_project": True}).json()[
        "project_id"
    ]
    write(1, "C7801/Keel.md", "Keel")

    created = client.post(
        "/api/tasks",
        json={
            "space_id": 1,
            "project_id": project_id,
            "title": " Keel drawings ",
            "deadline": "2026-10-10",
            "assignee": "Jose",
            "note_paths": ["C7801/Keel.md", "C7801/Keel.md"],
        },
    )
    assert created.status_code == 201
    task = created.json()
    assert task | {"id": 0} == {
        "id": 0,
        "space_id": 1,
        "project_id": project_id,
        "project_code": "C7801",
        "title": "Keel drawings",
        "description": "",
        "status": "backlog",
        "priority": "normal",
        "assignee": "Jose",
        "start_date": None,
        "deadline": "2026-10-10",
        "completion_percent": 0.0,
        "is_gantt_task": False,
        "is_milestone": False,
        "note_paths": ["C7801/Keel.md"],
    }
    client.post("/api/tasks", json={"space_id": 1, "title": "Unassigned", "status": "todo"})
    client.post("/api/tasks", json={"space_id": other, "title": "Private task"})

    def titles(**params):
        return [t["title"] for t in client.get("/api/tasks", params={"space_id": 1, **params}).json()]

    assert titles() == ["Keel drawings", "Unassigned"]
    assert titles(project_id=project_id) == ["Keel drawings"]
    assert titles(assignee="Jose") == ["Keel drawings"]
    assert titles(assignee="") == ["Unassigned"]
    assert titles(status="todo") == ["Unassigned"]
    assert titles(note_path="C7801/Keel.md") == ["Keel drawings"]
    assert [t["title"] for t in client.get("/api/tasks", params={"space_id": other}).json()] == ["Private task"]

    patched = client.patch(
        f"/api/tasks/{task['id']}", json={"status": "done", "title": "Keel drawings v2", "project_id": None}
    )
    assert patched.status_code == 200
    assert (patched.json()["status"], patched.json()["title"], patched.json()["project_id"]) == (
        "done",
        "Keel drawings v2",
        None,
    )
    assert patched.json()["completed_at"] is not None
    assert client.patch(f"/api/tasks/{task['id']}", json={"title": "  "}).status_code == 422
    assert client.patch(f"/api/tasks/{task['id']}", json={"project_id": 999}).status_code == 400

    unlinked = client.delete(f"/api/tasks/{task['id']}/links", params={"note_path": "C7801/Keel.md"}).json()
    assert unlinked["note_paths"] == []
    relinked = client.post(f"/api/tasks/{task['id']}/links", json={"note_path": "C7801/Keel.md"}).json()
    assert relinked["note_paths"] == ["C7801/Keel.md"]
    assert client.post(f"/api/tasks/{task['id']}/links", json={"note_path": "missing.md"}).status_code == 400

    assert client.delete(f"/api/tasks/{task['id']}").status_code == 204
    assert titles() == ["Unassigned"]
    assert client.get(f"/api/tasks/{task['id']}").status_code == 404


def test_create_task_validation(client):
    assert client.post("/api/tasks", json={"space_id": 1, "title": " "}).status_code == 422
    assert client.post("/api/tasks", json={"space_id": 1, "title": "x", "project_id": 42}).status_code == 400
    assert client.post("/api/tasks", json={"space_id": 7, "title": "x"}).status_code == 404
    assert client.post("/api/tasks", json={"space_id": 1, "title": "x", "note_paths": ["../a.md"]}).status_code == 400


def test_projects_and_gantt_are_per_space(client):
    other = client.post("/api/spaces", json={"name": "Private"}).json()["id"]
    with database.SessionLocal() as db:
        work, home, idle = Project(code="C7801", name="C7801"), Project(code="HOME", name="Home"), Project(code="X", name="X")
        db.add_all([work, home, idle])
        db.flush()
        db.add_all(
            [
                Task(project_id=work.id, title="Gantt", is_gantt_task=True, start_date=date(2026, 10, 1)),
                Task(space_id=other, project_id=home.id, title="Paint", is_gantt_task=True),
            ]
        )
        db.commit()

    assert [p["code"] for p in client.get("/api/projects", params={"space_id": 1}).json()] == ["C7801", "X"]
    assert [p["code"] for p in client.get("/api/projects", params={"space_id": other}).json()] == ["HOME"]
    assert [p["code"] for p in client.get("/api/gantt", params={"space_id": other}).json()["projects"]] == ["HOME"]


# --- Agent context ----------------------------------------------------------------


def reply(content=None, tool_calls=None):
    return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content=content, tool_calls=tool_calls))])


def tool_call(name, arguments):
    return SimpleNamespace(id="call-1", function=SimpleNamespace(name=name, arguments=json.dumps(arguments)))


@pytest.fixture
def model(monkeypatch):
    script, calls = [], []

    def completion(**kwargs):
        calls.append({**kwargs, "messages": list(kwargs["messages"])})
        return script.pop(0)

    monkeypatch.setattr(agent.litellm, "completion", completion)
    return SimpleNamespace(script=script, calls=calls)


@pytest.fixture
def settings():
    return Settings(_env_file=None, gemini_api_key="test-key", chat_model="gemini/test-model")


@pytest.fixture
def two_spaces(client):
    other = client.post("/api/spaces", json={"name": "Private"}).json()["id"]
    write(1, "Standards/ISO 12215.md", "Scantlings per ISO 12215-5.")
    write(1, "C7801/Design/Keel.md", "Keel design notes")
    write(other, "Garden.md", "Keel of the dinghy in the garden")
    client.put("/api/folders/meta", json={"space_id": 1, "path": "Standards", "is_reference": True})
    project_id = client.put("/api/folders/meta", json={"space_id": 1, "path": "C7801", "is_project": True}).json()[
        "project_id"
    ]
    task = client.post(
        "/api/tasks",
        json={"space_id": 1, "project_id": project_id, "title": "Keel drawings", "status": "todo", "note_paths": ["C7801/Design/Keel.md"]},
    ).json()
    client.post("/api/tasks", json={"space_id": 1, "project_id": project_id, "title": "Old", "status": "done"})
    client.post("/api/tasks", json={"space_id": other, "title": "Mow the lawn"})
    return SimpleNamespace(other=other, project_id=project_id, task=task)


def test_system_prompt_includes_reference_data_and_project_tasks(two_spaces, model, settings):
    model.script.append(reply("ok"))

    agent.run_chat(
        [ChatMessage(role="user", content="hi")],
        AccessMode.READ_ONLY,
        space_id=1,
        note_path="C7801/Design/Keel.md",
        settings=settings,
    )

    system = model.calls[0]["messages"][0]["content"]
    assert '("Default")' in system
    assert "Scantlings per ISO 12215-5." in system and "`Standards`" in system
    assert "project folder `C7801`" in system
    assert f"#{two_spaces.task['id']} Keel drawings · todo" in system
    assert "Old" not in system  # finished tasks are left out
    assert "Tasks linked to the open note" in system
    assert "Mow the lawn" not in system


def test_system_prompt_outside_a_project(two_spaces, model, settings):
    model.script.append(reply("ok"))

    agent.run_chat([ChatMessage(role="user", content="hi")], AccessMode.READ_ONLY, space_id=two_spaces.other, settings=settings)

    system = model.calls[0]["messages"][0]["content"]
    assert '("Private")' in system
    assert "Reference Data" not in system and "project folder" not in system


def test_chat_tools_are_limited_to_the_active_space(client, two_spaces, model, settings, monkeypatch):
    monkeypatch.setattr(agent, "get_settings", lambda: settings)
    model.script.extend(
        [reply(tool_calls=[tool_call("search_notes", {"query": "keel"})]), reply(tool_calls=[tool_call("list_tasks", {})]), reply("done")]
    )

    response = client.post(
        "/api/chat",
        json={"messages": [{"role": "user", "content": "keel?"}], "access_mode": "read_only", "space_id": two_spaces.other},
    )

    assert response.status_code == 200
    results = [json.loads(m["content"]) for m in model.calls[-1]["messages"] if isinstance(m, dict) and m["role"] == "tool"]
    assert [r["path"] for r in results[0]["results"]] == ["Garden.md"]
    assert [t["title"] for t in results[1]["tasks"]] == ["Mow the lawn"]
    assert client.post(
        "/api/chat", json={"messages": [{"role": "user", "content": "x"}], "space_id": 99}
    ).status_code == 404


def test_write_note_goes_to_the_active_space(client, two_spaces, model, settings, monkeypatch):
    monkeypatch.setattr(agent, "get_settings", lambda: settings)
    model.script.extend([reply(tool_calls=[tool_call("write_note", {"path": "Todo.md", "content": "Buy seeds"})]), reply("saved")])

    client.post(
        "/api/chat",
        json={"messages": [{"role": "user", "content": "note"}], "access_mode": "write_directly", "space_id": two_spaces.other},
    )

    assert (spaces.content_dir(two_spaces.other) / "Todo.md").is_file()
    assert not (spaces.content_dir(1) / "Todo.md").exists()
    with database.SessionLocal() as db:
        ids = db.scalars(select(HistoryRecord.entity_id).where(HistoryRecord.entity_type == "Note")).all()
    # Unique across spaces; Default space notes keep their bare path.
    assert f"spaces/{two_spaces.other}/content/Todo.md" in ids


def test_list_tasks_by_project_folder(two_spaces):
    assert [t["title"] for t in agent.list_tasks(project="c7801", space_id=1)["tasks"]] == ["Keel drawings"]
    with pytest.raises(agent.ToolError):
        agent.list_tasks(project="NOPE", space_id=1)


def test_folder_meta_is_per_space(two_spaces):
    with database.SessionLocal() as db:
        assert [m.path for m in db.scalars(select(FolderMeta).where(FolderMeta.space_id == two_spaces.other))] == []
    assert Status.BACKLOG.value == "backlog"


# --- Saved task views (Phase 9.1) -------------------------------------------------


def test_default_views_are_seeded_per_space(client):
    views = client.get("/api/views?space_id=1").json()
    assert [(v["name"], v["view_type"]) for v in views] == [("Kanban", "kanban"), ("Backlog", "backlog"), ("Gantt", "gantt")]
    assert views[0]["filters"] == {"project_id": None, "assignee": None}

    space = client.post("/api/spaces", json={"name": "Private"}).json()
    assert [v["view_type"] for v in client.get(f"/api/views?space_id={space['id']}").json()] == ["kanban", "backlog", "gantt"]
    assert client.get("/api/views?space_id=99").status_code == 404


def test_deleted_views_are_not_seeded_again(client):
    for view in client.get("/api/views?space_id=1").json():
        assert client.delete(f"/api/views/{view['id']}").status_code == 204
    with database.SessionLocal() as db:
        main.seed_views(db, 1)
    assert client.get("/api/views?space_id=1").json() == []


def test_view_crud(client):
    with database.SessionLocal() as db:
        db.add(Project(code="C7801", name="Hull"))
        db.commit()
        project_id = db.scalars(select(Project.id)).one()

    created = client.post(
        "/api/views",
        json={"space_id": 1, "name": " C7801 Kanban ", "view_type": "kanban", "filters": {"project_id": project_id}},
    )
    assert created.status_code == 201
    view = created.json()
    assert (view["name"], view["view_type"]) == ("C7801 Kanban", "kanban")
    assert view["filters"] == {"project_id": project_id, "assignee": None}
    assert client.get(f"/api/views/{view['id']}").json() == view

    renamed = client.put(f"/api/views/{view['id']}", json={"name": "Hull board"}).json()
    assert renamed["name"] == "Hull board"
    assert renamed["filters"]["project_id"] == project_id

    refiltered = client.put(f"/api/views/{view['id']}", json={"filters": {"assignee": " Jose "}}).json()
    assert refiltered["name"] == "Hull board"
    assert refiltered["filters"] == {"project_id": None, "assignee": "Jose"}

    assert client.delete(f"/api/views/{view['id']}").status_code == 204
    assert view["id"] not in [v["id"] for v in client.get("/api/views?space_id=1").json()]
    assert client.get(f"/api/views/{view['id']}").status_code == 404
    assert client.put(f"/api/views/{view['id']}", json={"name": "x"}).status_code == 404
    assert client.delete(f"/api/views/{view['id']}").status_code == 404

    with database.SessionLocal() as db:
        actions = db.scalars(
            select(HistoryRecord.action).where(
                HistoryRecord.entity_type == "TaskView", HistoryRecord.entity_id == str(view["id"])
            )
        ).all()
    assert actions == ["create", "update", "update", "delete"]


@pytest.mark.parametrize(
    "payload",
    [
        {"space_id": 1, "name": "  ", "view_type": "kanban"},
        {"space_id": 1, "name": "Board", "view_type": "calendar"},
        {"space_id": 1, "name": "x" * 65, "view_type": "kanban"},
    ],
)
def test_create_view_validation(client, payload):
    assert client.post("/api/views", json=payload).status_code == 422


def test_view_references_must_exist(client):
    assert client.post("/api/views", json={"space_id": 99, "name": "A", "view_type": "gantt"}).status_code == 404
    unknown_project = {"space_id": 1, "name": "A", "view_type": "gantt", "filters": {"project_id": 999}}
    assert client.post("/api/views", json=unknown_project).status_code == 400
    view_id = client.get("/api/views?space_id=1").json()[0]["id"]
    assert client.put(f"/api/views/{view_id}", json={"filters": {"project_id": 999}}).status_code == 400
    assert client.put(f"/api/views/{view_id}", json={"name": " "}).status_code == 422
