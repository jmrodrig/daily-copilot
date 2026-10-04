import copy
import datetime as dt

import pytest
from sqlalchemy import create_engine, func, inspect, select, text
from sqlalchemy.orm import sessionmaker

import file_layer
from cli_import import import_gantt
from database import init_db, make_engine
from file_layer import ApprovalRequiredError, delete_note, read_note, rename_note, write_note
from history import restore, set_source, soft_delete
from models import HistoryRecord, Link, Project, Task
from schemas import Status
from test_cli_import import GANTT_DATA


@pytest.fixture
def engine(tmp_path):
    engine = make_engine(f"sqlite:///{(tmp_path / 'copilot.db').as_posix()}")
    init_db(engine)
    yield engine
    engine.dispose()


@pytest.fixture
def session_factory(engine):
    return sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


def _history(session_factory, **filters) -> list[HistoryRecord]:
    with session_factory() as session:
        return list(session.scalars(select(HistoryRecord).filter_by(**filters).order_by(HistoryRecord.id)))


def _two_linked_tasks(session_factory) -> tuple[int, int, int]:
    with session_factory() as session, session.begin():
        project = Project(code="C7801", name="Hull 1")
        a, b = Task(title="a", project=project), Task(title="b", project=project)
        session.add_all([a, b])
        session.flush()
        link = Link(predecessor_id=a.id, successor_id=b.id)
        session.add(link)
        session.flush()
        return a.id, b.id, link.id


# --- Database rows ------------------------------------------------------------


def test_history_table_exists(engine):
    assert "history" in inspect(engine).get_table_names()
    for table in ("projects", "tasks", "links"):
        assert "deleted_at" in {c["name"] for c in inspect(engine).get_columns(table)}


def test_insert_records_full_snapshot(session_factory):
    with session_factory() as session, session.begin():
        session.add(Task(title="Keel delivery", status=Status.IN_PROGRESS, deadline=dt.date(2027, 3, 5)))

    [entry] = _history(session_factory)
    assert (entry.entity_type, entry.entity_id, entry.action, entry.source) == ("Task", "1", "create", "manual")
    assert isinstance(entry.timestamp, dt.datetime)
    snap = entry.snapshot
    assert snap["title"] == "Keel delivery"
    assert snap["status"] == "in_progress"
    assert snap["deadline"] == "2027-03-05"
    assert snap["deleted_at"] is None
    assert snap["created_at"]  # server default fetched on insert
    assert set(snap) == {c.key for c in inspect(Task).column_attrs}


def test_update_records_new_state(session_factory):
    with session_factory() as session, session.begin():
        session.add(Task(title="draft"))
    with session_factory() as session, session.begin():
        task = session.get(Task, 1)
        task.title = "final"
        task.status = Status.DONE

    create, update = _history(session_factory)
    assert create.snapshot["title"] == "draft"
    assert update.action == "update"
    assert (update.snapshot["title"], update.snapshot["status"]) == ("final", "done")


def test_unchanged_assignment_records_nothing(session_factory):
    with session_factory() as session, session.begin():
        session.add(Task(title="same"))
    with session_factory() as session, session.begin():
        session.get(Task, 1).title = "same"
    assert [h.action for h in _history(session_factory)] == ["create"]


def test_source_is_taken_from_the_session(engine, session_factory):
    with session_factory() as session, session.begin():
        set_source(session, "gemini")
        session.add(Project(code="R5301", name="R"))
    gemini_factory = sessionmaker(bind=engine, info={"source": "cli_import"})
    with gemini_factory() as session, session.begin():
        session.add(Project(code="P5002", name="P"))

    assert [h.source for h in _history(session_factory)] == ["gemini", "cli_import"]


def test_rollback_discards_history(session_factory):
    with pytest.raises(RuntimeError):
        with session_factory() as session, session.begin():
            session.add(Task(title="never"))
            session.flush()
            raise RuntimeError
    assert _history(session_factory) == []


def test_soft_deleting_task_also_deletes_its_links(session_factory):
    a_id, b_id, link_id = _two_linked_tasks(session_factory)
    with session_factory() as session, session.begin():
        soft_delete(session, session.get(Task, a_id))

    deletes = _history(session_factory, action="delete")
    assert {(h.entity_type, h.entity_id) for h in deletes} == {("Task", str(a_id)), ("Link", str(link_id))}
    assert all(h.snapshot["deleted_at"] for h in deletes)

    with session_factory() as session:
        # The rows are still there...
        assert session.scalar(select(func.count()).select_from(Task).execution_options(include_deleted=True)) == 2
        # ...but hidden from ordinary queries and relationship loads.
        assert session.scalars(select(Task.title)).all() == ["b"]
        assert session.get(Task, a_id) is None
        assert session.get(Task, b_id).predecessor_links == []
        assert session.scalar(select(Project)).tasks[0].title == "b"


def test_soft_deleting_project_deletes_its_tasks_and_links(session_factory):
    _two_linked_tasks(session_factory)
    with session_factory() as session, session.begin():
        soft_delete(session, session.scalar(select(Project)))
    deletes = _history(session_factory, action="delete")
    assert sorted(h.entity_type for h in deletes) == ["Link", "Project", "Task", "Task"]
    with session_factory() as session:
        assert session.scalar(select(func.count()).select_from(Task)) == 0
        assert session.scalar(select(func.count()).select_from(Link)) == 0


def test_soft_delete_twice_records_once(session_factory):
    with session_factory() as session, session.begin():
        session.add(Task(title="x"))
    for _ in range(2):
        with session_factory() as session, session.begin():
            task = session.scalar(select(Task).execution_options(include_deleted=True))
            soft_delete(session, task)
    assert [h.action for h in _history(session_factory)] == ["create", "delete"]


def test_restore_records_update(session_factory):
    with session_factory() as session, session.begin():
        task = Task(title="x")
        session.add(task)
        session.flush()
        soft_delete(session, task)
    with session_factory() as session, session.begin():
        restore(session.scalar(select(Task).execution_options(include_deleted=True)))

    actions = [(h.action, h.snapshot["deleted_at"] is None) for h in _history(session_factory)]
    assert actions == [("create", True), ("delete", False), ("update", True)]
    with session_factory() as session:
        assert session.scalar(select(Task.title)) == "x"


def test_hard_delete_keeps_last_snapshot(session_factory):
    with session_factory() as session, session.begin():
        session.add(Task(title="scratch"))
    with session_factory() as session, session.begin():
        session.delete(session.get(Task, 1))

    delete = _history(session_factory)[-1]
    assert (delete.action, delete.entity_id, delete.snapshot["title"]) == ("delete", "1", "scratch")


def test_init_db_adds_deleted_at_to_an_existing_database(tmp_path):
    db_file = tmp_path / "old.db"
    old = create_engine(f"sqlite:///{db_file.as_posix()}")
    with old.begin() as conn:
        conn.execute(text("CREATE TABLE projects (id INTEGER PRIMARY KEY, code VARCHAR(32) NOT NULL, name VARCHAR NOT NULL, "
                          "description VARCHAR NOT NULL, active BOOLEAN NOT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL)"))
        conn.execute(text("INSERT INTO projects (code, name, description, active) VALUES ('C7801', 'Hull', '', 1)"))
    old.dispose()

    engine = make_engine(f"sqlite:///{db_file.as_posix()}")
    try:
        init_db(engine)
        init_db(engine)  # idempotent
        assert "deleted_at" in {c["name"] for c in inspect(engine).get_columns("projects")}
        with sessionmaker(bind=engine)() as session:
            assert session.scalar(select(Project.code)) == "C7801"
    finally:
        engine.dispose()


# --- Gantt import -------------------------------------------------------------


def test_gantt_reimport_history(session_factory):
    data = copy.deepcopy(GANTT_DATA)
    with session_factory() as session, session.begin():
        import_gantt(session, data, "C7801")
    with session_factory() as session, session.begin():
        import_gantt(session, data, "C7801")

    entries = _history(session_factory)
    assert {h.source for h in entries} == {"cli_import"}
    counts = {}
    for h in entries:
        counts[(h.entity_type, h.action)] = counts.get((h.entity_type, h.action), 0) + 1
    assert counts == {
        ("Project", "create"): 1,
        ("Task", "create"): 6,
        ("Link", "create"): 2,
        ("Task", "delete"): 3,
        ("Link", "delete"): 1,
    }


def test_gantt_import_restores_soft_deleted_project(session_factory):
    data = copy.deepcopy(GANTT_DATA)
    with session_factory() as session, session.begin():
        import_gantt(session, data, "C7801")
        soft_delete(session, session.scalar(select(Project)))
    with session_factory() as session, session.begin():
        result = import_gantt(session, data, "C7801")

    assert result.created_project is False
    with session_factory() as session:
        assert session.scalar(select(Project.code)) == "C7801"
        assert len(session.scalar(select(Project)).tasks) == 3


# --- Notes --------------------------------------------------------------------


@pytest.fixture
def note_history(default_db):
    factory = sessionmaker(bind=default_db)
    return lambda **filters: _history(factory, entity_type="Note", **filters)


def test_write_note_records_create_then_update(notes_dir, note_history):
    write_note("c7801/kickoff.md", "v1\n", {"title": "Kickoff", "created": dt.date(2026, 10, 2)}, "write_directly")
    write_note("c7801/kickoff.md", "v2\n", {"title": "Kickoff"}, "write_directly", source="gemini")

    create, update = note_history()
    assert (create.entity_id, create.action, create.source) == ("c7801/kickoff.md", "create", "manual")
    assert create.snapshot == {
        "path": "c7801/kickoff.md",
        "frontmatter": {"title": "Kickoff", "created": "2026-10-02"},
        "content": "v1\n",
    }
    assert (update.action, update.source, update.snapshot["content"]) == ("update", "gemini", "v2\n")


def test_unchanged_or_refused_writes_record_nothing(notes_dir, note_history):
    write_note("n.md", "x", {}, "write_directly")
    assert write_note("n.md", "x", {}, "write_directly") is False
    with pytest.raises(PermissionError):
        write_note("n.md", "y", {}, "read_only")
    with pytest.raises(ApprovalRequiredError):
        write_note("n.md", "y", {}, "ask_first")
    assert [h.action for h in note_history()] == ["create"]


def test_failed_write_records_nothing(notes_dir, note_history, monkeypatch):
    def fail(*_args):
        raise OSError("disk full")

    monkeypatch.setattr(file_layer.os, "replace", fail)
    with pytest.raises(OSError):
        write_note("n.md", "x", {}, "write_directly")
    assert note_history() == []
    assert list(notes_dir.iterdir()) == []


def test_rename_note(notes_dir, note_history):
    write_note("draft.md", "body", {"title": "T"}, "write_directly")
    rename_note("draft.md", "final/plan.md", "write_directly", source="manual")

    assert not (notes_dir / "draft.md").exists()
    assert read_note("final/plan.md")["content"] == "body"
    rename = note_history()[-1]
    assert (rename.entity_id, rename.action) == ("final/plan.md", "rename")
    assert rename.snapshot == {
        "path": "final/plan.md",
        "previous_path": "draft.md",
        "frontmatter": {"title": "T"},
        "content": "body",
    }


def test_rename_refuses_to_overwrite(notes_dir, note_history):
    write_note("a.md", "a", {}, "write_directly")
    write_note("b.md", "b", {}, "write_directly")
    with pytest.raises(FileExistsError):
        rename_note("a.md", "b.md", "write_directly")
    assert read_note("b.md")["content"] == "b"
    assert [h.action for h in note_history()] == ["create", "create"]


def test_delete_note_keeps_content_in_history(notes_dir, note_history):
    write_note("gone.md", "remember me", {"tags": ["x"]}, "write_directly")
    delete_note("gone.md", "write_directly", source="gemini")

    assert not (notes_dir / "gone.md").exists()
    delete = note_history()[-1]
    assert (delete.entity_id, delete.action, delete.source) == ("gone.md", "delete", "gemini")
    assert delete.snapshot == {"path": "gone.md", "frontmatter": {"tags": ["x"]}, "content": "remember me"}


def test_delete_and_rename_respect_access_modes(notes_dir, note_history):
    write_note("keep.md", "body", {}, "write_directly")
    with pytest.raises(PermissionError):
        delete_note("keep.md", "read_only")
    with pytest.raises(ApprovalRequiredError) as excinfo:
        rename_note("keep.md", "moved.md", "ask_first")
    assert (excinfo.value.action, excinfo.value.new_path) == ("rename", notes_dir / "moved.md")
    with pytest.raises(ApprovalRequiredError) as excinfo:
        delete_note("keep.md", "ask_first")
    assert (excinfo.value.action, excinfo.value.content) == ("delete", "body")

    assert (notes_dir / "keep.md").exists()
    assert [h.action for h in note_history()] == ["create"]

    delete_note("keep.md", "ask_first", approved=True)
    assert not (notes_dir / "keep.md").exists()
