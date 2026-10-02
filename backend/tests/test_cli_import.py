import copy
import datetime as dt

import pytest
from sqlalchemy import func, inspect, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import sessionmaker

import cli_import
import schemas
from cli_import import confirm, import_gantt, main, resolve_project_code, summarize
from database import init_db, make_engine
from models import Link, Project, Task
from schemas import LinkType, Status

GANTT_DATA = {
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
            "percent_complete": 100,
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
def engine(tmp_path):
    engine = make_engine(f"sqlite:///{(tmp_path / 'copilot.db').as_posix()}")
    init_db(engine)
    yield engine
    engine.dispose()


@pytest.fixture
def session_factory(engine):
    return sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


@pytest.fixture
def data():
    return copy.deepcopy(GANTT_DATA)


@pytest.fixture
def fake_extract(monkeypatch, data):
    """Stub the LLM pipeline; records the paths it was called with."""
    calls = []

    def extract(pdf_path):
        calls.append(pdf_path)
        return data

    monkeypatch.setattr(cli_import, "extract_gantt_data", extract)
    return calls


def _answers(*answers):
    replies = iter(answers)
    return lambda _prompt: next(replies)


# --- ORM models ---------------------------------------------------------------


def test_init_db_creates_tables(engine):
    assert {"projects", "tasks", "links"} <= set(inspect(engine).get_table_names())


def test_models_round_trip_to_schemas(session_factory):
    with session_factory() as session, session.begin():
        project = Project(code="C7801", name="Hull 1")
        session.add(project)
        session.flush()
        first = Task(project_id=project.id, title="Keel delivery", status=Status.IN_PROGRESS)
        second = Task(project_id=project.id, title="Keel install", deadline=dt.date(2027, 3, 19))
        session.add_all([first, second])
        session.flush()
        session.add(Link(predecessor_id=first.id, successor_id=second.id, lag_days=2))

    with session_factory() as session:
        project = session.scalar(select(Project))
        assert schemas.Project.model_validate(project, from_attributes=True).code == "C7801"
        assert project.created_at is not None
        assert [t.title for t in project.tasks] == ["Keel delivery", "Keel install"]

        task = schemas.Task.model_validate(project.tasks[1], from_attributes=True)
        assert task.deadline == dt.date(2027, 3, 19)
        assert task.status is Status.TODO
        assert task.is_gantt_task is False

        link = schemas.Link.model_validate(session.scalar(select(Link)), from_attributes=True)
        assert (link.type, link.lag_days) == (LinkType.FINISH_TO_START, 2)
        assert project.tasks[0].successor_links[0].successor.title == "Keel install"


def test_project_code_is_unique(session_factory):
    with pytest.raises(IntegrityError):
        with session_factory() as session, session.begin():
            session.add_all([Project(code="C7801", name="a"), Project(code="C7801", name="b")])


def test_deleting_task_cascades_to_links(session_factory):
    with session_factory() as session, session.begin():
        a, b = Task(title="a"), Task(title="b")
        session.add_all([a, b])
        session.flush()
        session.add(Link(predecessor_id=a.id, successor_id=b.id))
    with session_factory() as session, session.begin():
        session.delete(session.get(Task, a.id))
    with session_factory() as session:
        assert session.scalar(select(func.count()).select_from(Link)) == 0


# --- import_gantt -------------------------------------------------------------


def test_import_gantt_creates_project_tasks_and_links(session_factory, data):
    with session_factory() as session, session.begin():
        result = import_gantt(session, data, "C7801")

    assert result == cli_import.ImportResult(
        project_code="C7801", created_project=True, replaced_tasks=0, tasks=2, milestones=1, links=1
    )
    with session_factory() as session:
        project = session.scalar(select(Project).where(Project.code == "C7801"))
        assert project.name == "C7801 Project Plan"
        tasks = {t.title: t for t in project.tasks}
        assert all(t.is_gantt_task for t in tasks.values())

        delivery = tasks["Keel delivery"]
        assert delivery.status is Status.DONE
        assert (delivery.start_date, delivery.deadline) == (dt.date(2027, 3, 1), dt.date(2027, 3, 5))
        assert "Section: Superstructure & deck" in delivery.description
        assert "Trade: Sub contractor" in delivery.description
        assert tasks["Keel install"].status is Status.TODO

        milestone = tasks["STAGE PAYMENT - Roll out/keel"]
        assert milestone.is_milestone and milestone.deadline == dt.date(2027, 3, 22)

        link = session.scalar(select(Link))
        assert (link.predecessor.title, link.successor.title) == ("Keel delivery", "Keel install")


def test_reimport_replaces_gantt_tasks_only(session_factory, data):
    with session_factory() as session, session.begin():
        import_gantt(session, data, "C7801")
        project = session.scalar(select(Project))
        session.add(Task(project_id=project.id, title="Order paint", is_gantt_task=False))

    data["project_name"] = "C7801 rev B"
    data["tasks"] = data["tasks"][1:]
    data["dependencies"] = []
    with session_factory() as session, session.begin():
        result = import_gantt(session, data, "C7801")

    assert (result.created_project, result.replaced_tasks, result.tasks) == (False, 3, 1)
    with session_factory() as session:
        assert session.scalar(select(func.count()).select_from(Project)) == 1
        assert session.scalar(select(Project.name)) == "C7801 rev B"
        titles = set(session.scalars(select(Task.title)))
        assert titles == {"Keel install", "STAGE PAYMENT - Roll out/keel", "Order paint"}
        assert session.scalar(select(func.count()).select_from(Link)) == 0


def test_import_gantt_skips_duplicate_and_self_links(session_factory, data):
    dep = data["dependencies"][0]
    data["dependencies"] += [dict(dep), {"predecessor": "T1", "successor": "T1"}]
    with session_factory() as session, session.begin():
        assert import_gantt(session, data, "C7801").links == 1


# --- helpers ------------------------------------------------------------------


def test_resolve_project_code_falls_back_to_file_name(data):
    assert resolve_project_code(data, "x.pdf") == "C7801"
    data["project_code"] = None
    assert resolve_project_code(data, "../docs/gantt/R5301 Project Plan.pdf") == "R5301"
    assert resolve_project_code(data, "plan.pdf") is None


def test_summarize_counts(data):
    data["tasks"][1]["end"] = None
    text = summarize(data, "C7801")
    assert "Project code:  C7801" in text
    assert "Tasks:         2 (1 missing start/end)" in text
    assert "Milestones:    1" in text
    assert "Dependencies:  1" in text
    assert "Date range:    2027-03-01 to 2027-03-05" in text


@pytest.mark.parametrize(
    ("answers", "expected"),
    [(["Y"], True), (["yes"], True), (["n"], False), (["maybe", " y "], True)],
)
def test_confirm(answers, expected, capsys):
    assert confirm(input_fn=_answers(*answers)) is expected


def test_confirm_treats_eof_as_no():
    def eof(_prompt):
        raise EOFError

    assert confirm(input_fn=eof) is False


# --- main ---------------------------------------------------------------------


def test_main_imports_on_approval(fake_extract, session_factory, capsys):
    code = main(["plan.pdf"], input_fn=_answers("Y"), session_factory=session_factory)

    assert code == 0
    assert fake_extract == ["plan.pdf"]
    out = capsys.readouterr().out
    assert '"project_code": "C7801"' in out
    assert "Tasks:         2" in out
    assert "Created project C7801: imported 2 tasks, 1 milestones and 1 links." in out
    with session_factory() as session:
        assert session.scalar(select(func.count()).select_from(Task)) == 3


def test_main_writes_nothing_when_declined(fake_extract, session_factory, capsys):
    code = main(["plan.pdf"], input_fn=_answers("N"), session_factory=session_factory)

    assert code == 0
    assert "Import cancelled" in capsys.readouterr().out
    with session_factory() as session:
        assert session.scalar(select(func.count()).select_from(Project)) == 0


def test_main_code_override(fake_extract, session_factory):
    main(["plan.pdf", "--code", "P5002"], input_fn=_answers("y"), session_factory=session_factory)
    with session_factory() as session:
        assert session.scalar(select(Project.code)) == "P5002"


def test_main_requires_project_code(fake_extract, data, session_factory, capsys):
    data["project_code"] = None
    code = main(["plan.pdf"], input_fn=_answers("y"), session_factory=session_factory)
    assert code == 1
    assert "no project code found" in capsys.readouterr().err


def test_main_reports_extraction_errors(monkeypatch, capsys):
    def fail(_pdf_path):
        raise cli_import.GanttParseError("COPILOT_GEMINI_API_KEY is not set")

    monkeypatch.setattr(cli_import, "extract_gantt_data", fail)
    assert main(["plan.pdf"], input_fn=_answers()) == 1
    assert "Error: COPILOT_GEMINI_API_KEY is not set" in capsys.readouterr().err
