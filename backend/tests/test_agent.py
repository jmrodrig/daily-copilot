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
from config import Settings
from models import HistoryRecord, Project, Task
from schemas import AccessMode, ChatMessage, Status


@pytest.fixture
def settings(monkeypatch):
    settings = Settings(_env_file=None, gemini_api_key="test-key", chat_model="gemini/test-model")
    monkeypatch.setattr(agent, "get_settings", lambda: settings)
    return settings


def tool_call(name, arguments, call_id="call-1"):
    raw = arguments if isinstance(arguments, str) else json.dumps(arguments)
    return SimpleNamespace(id=call_id, function=SimpleNamespace(name=name, arguments=raw))


def reply(content=None, tool_calls=None):
    return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content=content, tool_calls=tool_calls))])


@pytest.fixture
def model(monkeypatch):
    """Replace litellm.completion with a script of responses, so tests never call the real API."""
    script, calls = [], []

    def completion(**kwargs):
        calls.append({**kwargs, "messages": list(kwargs["messages"])})
        return script.pop(0)

    monkeypatch.setattr(agent.litellm, "completion", completion)
    return SimpleNamespace(script=script, calls=calls)


@pytest.fixture
def client(notes_dir, settings, monkeypatch):
    monkeypatch.setattr(main, "init_db", lambda: None)
    with TestClient(main.app) as client:
        yield client


def chat(client, text, mode="ask_first"):
    return client.post("/api/chat", json={"messages": [{"role": "user", "content": text}], "access_mode": mode})


def tool_results(call):
    return [json.loads(m["content"]) for m in call["messages"] if isinstance(m, dict) and m["role"] == "tool"]


def note_history():
    with database.SessionLocal() as session:
        records = session.scalars(select(HistoryRecord).where(HistoryRecord.entity_type == "Note")).all()
    return [(r.entity_id, r.action, r.source) for r in records]


# --- Chat loop ----------------------------------------------------------------


def test_chat_answers_without_tools(client, model):
    model.script.append(reply("Hello Jose"))

    response = chat(client, "Hi")

    assert response.status_code == 200
    assert response.json() == {"reply": "Hello Jose", "proposed_edits": [], "written_paths": [], "tool_calls": []}
    call = model.calls[0]
    assert call["model"] == "gemini/test-model"
    assert call["api_key"] == "test-key"
    assert call["messages"][0]["role"] == "system"
    assert call["messages"][1:] == [{"role": "user", "content": "Hi"}]


def test_chat_sends_the_conversation_so_far(client, model):
    model.script.append(reply("Yes"))
    messages = [
        {"role": "user", "content": "First"},
        {"role": "assistant", "content": "Answer"},
        {"role": "user", "content": "Second"},
    ]

    client.post("/api/chat", json={"messages": messages, "access_mode": "read_only"})

    assert model.calls[0]["messages"][1:] == messages


def test_chat_runs_tools_and_feeds_results_back(client, notes_dir, model):
    file_layer.write_note("C7801/Keel.md", "We chose a lead keel.", {"type": "decision"}, "write_directly")
    model.script += [
        reply(tool_calls=[tool_call("search_notes", {"query": "keel", "project": "C7801"})]),
        reply(tool_calls=[tool_call("read_note", {"path": "C7801/Keel.md"}, "call-2")]),
        reply("A lead keel (C7801/Keel.md)."),
    ]

    body = chat(client, "What did we decide about the keel design in C7801?").json()

    assert body["reply"] == "A lead keel (C7801/Keel.md)."
    assert body["tool_calls"] == [
        {"name": "search_notes", "arguments": {"query": "keel", "project": "C7801"}, "ok": True},
        {"name": "read_note", "arguments": {"path": "C7801/Keel.md"}, "ok": True},
    ]
    search, read = tool_results(model.calls[2])
    assert [r["path"] for r in search["results"]] == ["C7801/Keel.md"]
    assert read == {"path": "C7801/Keel.md", "frontmatter": {"type": "decision"}, "content": "We chose a lead keel."}
    tool_messages = [m for m in model.calls[2]["messages"] if isinstance(m, dict) and m["role"] == "tool"]
    assert [m["tool_call_id"] for m in tool_messages] == ["call-1", "call-2"]


def test_tool_errors_are_returned_to_the_model(client, model):
    model.script += [
        reply(
            tool_calls=[
                tool_call("read_note", {"path": "Missing.md"}),
                tool_call("read_note", {"path": "../outside.md"}, "call-2"),
                tool_call("read_note", "not json", "call-3"),
                tool_call("read_note", {"nope": 1}, "call-4"),
                tool_call("delete_everything", {}, "call-5"),
            ]
        ),
        reply("Sorry"),
    ]

    body = chat(client, "Read things").json()

    assert [c["ok"] for c in body["tool_calls"]] == [False] * 5
    errors = [r["error"] for r in tool_results(model.calls[1])]
    assert "No note at Missing.md" in errors[0]
    assert "outside the notes directory" in errors[1]
    assert errors[2].startswith("Invalid arguments")
    assert errors[3].startswith("Bad arguments for read_note")
    assert errors[4] == "Unknown tool: delete_everything"


def test_chat_stops_calling_tools_after_max_rounds(client, model):
    looping = reply(tool_calls=[tool_call("search_notes", {"query": ""})])
    model.script += [looping] * agent.MAX_TOOL_ROUNDS + [reply("Best effort answer")]

    body = chat(client, "Loop").json()

    assert body["reply"] == "Best effort answer"
    assert len(model.calls) == agent.MAX_TOOL_ROUNDS + 1
    assert [c["tool_choice"] for c in model.calls] == ["auto"] * agent.MAX_TOOL_ROUNDS + ["none"]


def test_chat_without_api_key(client, settings, model):
    settings.gemini_api_key = None

    response = chat(client, "Hi")

    assert response.status_code == 503
    assert "COPILOT_GEMINI_API_KEY" in response.json()["detail"]
    assert model.calls == []


def test_chat_model_failure(client, monkeypatch):
    def completion(**_kwargs):
        raise RuntimeError("quota exceeded")

    monkeypatch.setattr(agent.litellm, "completion", completion)

    response = chat(client, "Hi")

    assert response.status_code == 502
    assert "quota exceeded" in response.json()["detail"]


@pytest.mark.parametrize(
    "payload",
    [
        {"messages": []},
        {"messages": [{"role": "assistant", "content": "Hi"}]},
        {"messages": [{"role": "user", "content": "   "}]},
        {"messages": [{"role": "user", "content": "Hi"}], "access_mode": "admin"},
    ],
)
def test_chat_rejects_invalid_requests(client, payload):
    assert client.post("/api/chat", json=payload).status_code == 422


# --- Access modes ---------------------------------------------------------------


def test_read_only_does_not_offer_or_allow_writes(client, notes_dir, model):
    model.script += [
        reply(tool_calls=[tool_call("write_note", {"path": "C7801/New.md", "content": "x"})]),
        reply("I can't write in read only mode."),
    ]

    body = chat(client, "Write a note", mode="read_only").json()

    offered = [t["function"]["name"] for t in model.calls[0]["tools"]]
    assert offered == ["search_notes", "read_note", "list_tasks"]
    assert "READ ONLY" in model.calls[0]["messages"][0]["content"]
    assert tool_results(model.calls[1]) == [{"error": "Unknown tool: write_note"}]
    assert body["proposed_edits"] == [] and body["written_paths"] == []
    assert not (notes_dir / "C7801/New.md").exists()


def test_ask_first_proposes_instead_of_writing(client, notes_dir, model):
    file_layer.write_note("C7801/Summary.md", "Old", {"type": "wiki", "created": date(2026, 9, 1)}, "write_directly")
    before = note_history()
    model.script += [
        reply(
            tool_calls=[
                tool_call("write_note", {"path": "C7801/Summary.md", "content": "Draft"}),
                tool_call("write_note", {"path": "C7801/Summary.md", "content": "New"}, "call-2"),
                tool_call("write_note", {"path": "C7801/Fresh.md", "content": "Hi", "frontmatter": {"type": "wiki"}}, "call-3"),
            ]
        ),
        reply("Two edits are waiting for your approval."),
    ]

    body = chat(client, "Summarise the tasks", mode="ask_first").json()

    assert [r["status"] for r in tool_results(model.calls[1])] == ["proposed"] * 3
    summary, fresh = body["proposed_edits"]
    assert summary == {
        "path": "C7801/Summary.md",
        "content": "New",  # the later proposal for the same note replaces the earlier one
        "frontmatter": {"type": "wiki", "created": "2026-09-01"},  # kept from the existing note
        "previous_content": "Old",
        "previous_frontmatter": {"type": "wiki", "created": "2026-09-01"},
        "base_hash": file_layer.note_hash("C7801/Summary.md"),
    }
    assert fresh["previous_content"] is None and fresh["base_hash"] is None
    assert body["written_paths"] == []
    assert file_layer.read_note("C7801/Summary.md")["content"] == "Old"
    assert not (notes_dir / "C7801/Fresh.md").exists()
    assert note_history() == before


def test_ask_first_identical_content_is_not_proposed(client, model):
    file_layer.write_note("C7801/Same.md", "Same", {}, "write_directly")
    model.script += [
        reply(tool_calls=[tool_call("write_note", {"path": "C7801/Same.md", "content": "Same"})]),
        reply("Nothing to change."),
    ]

    body = chat(client, "Rewrite it").json()

    assert tool_results(model.calls[1]) == [{"status": "unchanged", "path": "C7801/Same.md"}]
    assert body["proposed_edits"] == []


def test_write_directly_writes_and_records_history(client, notes_dir, model):
    model.script += [
        reply(
            tool_calls=[
                tool_call(
                    "write_note",
                    {"path": "C7801/Tasks.md", "content": "# Tasks", "frontmatter": {"project": "C7801"}},
                )
            ]
        ),
        reply("Wrote C7801/Tasks.md"),
    ]

    body = chat(client, "Write it", mode="write_directly").json()

    assert body["written_paths"] == ["C7801/Tasks.md"]
    assert body["proposed_edits"] == []
    assert body["tool_calls"] == [
        {"name": "write_note", "arguments": {"path": "C7801/Tasks.md", "frontmatter": {"project": "C7801"}}, "ok": True}
    ]
    assert file_layer.read_note("C7801/Tasks.md") == {
        "path": "C7801/Tasks.md",
        "frontmatter": {"project": "C7801"},
        "content": "# Tasks",
    }
    assert note_history() == [("C7801/Tasks.md", "create", "copilot_agent")]


def test_write_rejects_paths_outside_notes(client, notes_dir, model):
    model.script += [
        reply(tool_calls=[tool_call("write_note", {"path": "../evil.md", "content": "x"})]),
        reply("Could not write"),
    ]

    body = chat(client, "Write it", mode="write_directly").json()

    assert body["tool_calls"][0]["ok"] is False
    assert not (notes_dir.parent / "evil.md").exists()


# --- Apply edit -------------------------------------------------------------------


def test_apply_edit_writes_approved_edit(client, notes_dir, model):
    model.script += [
        reply(tool_calls=[tool_call("write_note", {"path": "C7801/Plan.md", "content": "Plan", "frontmatter": {}})]),
        reply("Waiting for approval"),
    ]
    edit = chat(client, "Write a plan").json()["proposed_edits"][0]

    response = client.post("/api/notes/apply-edit", json=edit)

    assert response.status_code == 200
    assert response.json() == {"path": "C7801/Plan.md", "written": True}
    assert file_layer.read_note("C7801/Plan.md")["content"] == "Plan"
    assert note_history() == [("C7801/Plan.md", "create", "copilot_agent_approved")]


def test_apply_edit_keeps_frontmatter_types(client):
    frontmatter = {"type": "meeting", "created": date(2026, 9, 1)}
    file_layer.write_note("R5301/Meeting.md", "Old", frontmatter, "write_directly")
    edit = {
        "path": "R5301/Meeting.md",
        "content": "New",
        "frontmatter": {"type": "meeting", "created": "2026-09-01"},
        "base_hash": file_layer.note_hash("R5301/Meeting.md"),
    }

    assert client.post("/api/notes/apply-edit", json=edit).status_code == 200
    assert file_layer.read_note("R5301/Meeting.md")["frontmatter"] == frontmatter


def test_apply_edit_refuses_if_note_changed(client):
    file_layer.write_note("C7801/Plan.md", "v1", {}, "write_directly")
    stale = file_layer.note_hash("C7801/Plan.md")
    file_layer.write_note("C7801/Plan.md", "v2 by hand", {}, "write_directly")

    response = client.post(
        "/api/notes/apply-edit", json={"path": "C7801/Plan.md", "content": "agent", "base_hash": stale}
    )

    assert response.status_code == 409
    assert file_layer.read_note("C7801/Plan.md")["content"] == "v2 by hand"


def test_apply_edit_refuses_new_note_that_now_exists(client):
    file_layer.write_note("C7801/Plan.md", "made meanwhile", {}, "write_directly")

    response = client.post("/api/notes/apply-edit", json={"path": "C7801/Plan.md", "content": "agent"})

    assert response.status_code == 409


@pytest.mark.parametrize("path", ["../escape.md", "C7801/notes.txt"])
def test_apply_edit_rejects_bad_paths(client, path):
    response = client.post("/api/notes/apply-edit", json={"path": path, "content": "x"})

    assert response.status_code == 400


# --- Tools ----------------------------------------------------------------------


def test_search_notes_ranks_by_terms_matched(notes_dir):
    file_layer.write_note("C7801/Keel.md", "Keel design: lead keel, deep fin.", {}, "write_directly")
    file_layer.write_note("C7801/Rudder.md", "Rudder stock design.", {}, "write_directly")
    file_layer.write_note("R5301/Keel.md", "Keel bolts.", {"type": "decision"}, "write_directly")
    file_layer.write_note("Inbox/Other.md", "Nothing related.", {}, "write_directly")

    found = agent.search_notes("keel design")

    assert found["total_matches"] == 3
    assert [r["path"] for r in found["results"]] == ["C7801/Keel.md", "R5301/Keel.md", "C7801/Rudder.md"]
    assert found["results"][1] == {"path": "R5301/Keel.md", "project": "R5301", "type": "decision", "snippet": "Keel bolts."}
    assert [r["path"] for r in agent.search_notes("keel", project="R5301")["results"]] == ["R5301/Keel.md"]
    assert agent.search_notes("")["total_matches"] == 4


def test_search_notes_snippet_and_bad_project(notes_dir):
    file_layer.write_note("C7801/Long.md", "x " * 200 + "the transom weld spec " + "y " * 200, {}, "write_directly")

    snippet = agent.search_notes("transom")["results"][0]["snippet"]

    assert snippet.startswith("…") and snippet.endswith("…") and "transom weld spec" in snippet
    with pytest.raises(agent.ToolError):
        agent.search_notes("x", project="../etc")


def test_search_notes_skips_broken_notes(notes_dir):
    (notes_dir / "Bad.md").write_text("---\n[unclosed\n---\nkeel", encoding="utf-8")
    file_layer.write_note("Good.md", "keel", {}, "write_directly")

    assert [r["path"] for r in agent.search_notes("keel")["results"]] == ["Good.md"]


def test_list_tasks(monkeypatch):
    monkeypatch.setattr(agent, "date", type("FixedDate", (), {"today": staticmethod(lambda: date(2026, 10, 3))}))
    with database.SessionLocal() as session:
        c7801, r5301 = Project(code="C7801", name="C7801"), Project(code="R5301", name="R5301")
        archived = Project(code="X0001", name="Old", active=False)
        session.add_all([c7801, r5301, archived])
        session.flush()
        session.add_all(
            [
                Task(project_id=c7801.id, title="Late gelcoat", deadline=date(2026, 10, 2), assignee="Jose"),
                Task(project_id=c7801.id, title="Lamination", deadline=date(2026, 10, 10)),
                Task(project_id=c7801.id, title="Done late", deadline=date(2026, 9, 1), status=Status.DONE),
                Task(project_id=c7801.id, title="Imported done", deadline=date(2026, 9, 1), description="Complete: 100%"),
                Task(project_id=r5301.id, title="R late", deadline=date(2026, 9, 30)),
                Task(project_id=archived.id, title="Archived late", deadline=date(2026, 1, 1)),
            ]
        )
        session.commit()

    overdue = agent.list_tasks(project="c7801", overdue_only=True)
    everything = agent.list_tasks(include_done=True)

    assert overdue["today"] == "2026-10-03"
    assert [(t["title"], t["assignee"], t["overdue"]) for t in overdue["tasks"]] == [("Late gelcoat", "Jose", True)]
    assert [t["title"] for t in agent.list_tasks()["tasks"]] == ["Late gelcoat", "Lamination", "R late"]
    assert [t["title"] for t in everything["tasks"]] == ["Done late", "Imported done", "Late gelcoat", "Lamination", "R late"]
    assert [t["overdue"] for t in everything["tasks"]] == [False, False, True, False, True]


def test_run_chat_system_prompt_reflects_mode(settings, model, notes_dir):
    for mode, marker in [
        (AccessMode.ASK_FIRST, "ASK FIRST"),
        (AccessMode.WRITE_DIRECTLY, "WRITE DIRECTLY"),
    ]:
        model.script.append(reply("ok"))
        agent.run_chat([ChatMessage(role="user", content="hi")], mode, settings=settings)
        assert marker in model.calls[-1]["messages"][0]["content"]
        assert "write_note" in [t["function"]["name"] for t in model.calls[-1]["tools"]]
