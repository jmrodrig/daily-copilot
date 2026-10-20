import io
import json
import queue
from datetime import date
from email.message import Message
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


def test_chat_passes_reasoning_effort(client, model):
    model.script += [reply("Hi"), reply("Hi")]

    client.post("/api/chat", json={"messages": [{"role": "user", "content": "Hi"}], "reasoning_effort": "high"})
    chat(client, "Hi")

    assert model.calls[0]["reasoning_effort"] == "high"
    assert "reasoning_effort" not in model.calls[1]


def test_chat_rejects_unknown_reasoning_effort(client, model):
    body = {"messages": [{"role": "user", "content": "Hi"}], "reasoning_effort": "max"}
    assert client.post("/api/chat", json=body).status_code == 422


def test_chat_drops_reasoning_effort_the_model_does_not_support(client, monkeypatch):
    calls = []

    def completion(**kwargs):
        calls.append(kwargs)
        if "reasoning_effort" in kwargs:
            raise agent.litellm.UnsupportedParamsError(message="no effort", llm_provider="gemini", model="m")
        return reply("Fine")

    monkeypatch.setattr(agent.litellm, "completion", completion)
    body = {"messages": [{"role": "user", "content": "Hi"}], "reasoning_effort": "low"}

    response = client.post("/api/chat", json=body)

    assert response.status_code == 200
    assert response.json()["reply"] == "Fine"
    assert ["reasoning_effort" in c for c in calls] == [True, False]


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
    assert [c["tool_choice"] for c in model.calls[:-1]] == ["auto"] * agent.MAX_TOOL_ROUNDS
    # Gemini keeps calling declared tools despite tool_choice="none", so the last round declares none.
    final = model.calls[-1]
    assert "tools" not in final and "tool_choice" not in final
    assert final["messages"][-1] == {"role": "user", "content": agent.FINAL_ANSWER_PROMPT}


def test_chat_never_returns_an_empty_reply_after_max_rounds(client, model):
    looping = reply(tool_calls=[tool_call("search_notes", {"query": "keel"})])
    model.script += [looping] * agent.MAX_TOOL_ROUNDS + [reply(tool_calls=[tool_call("search_notes", {"query": ""})])]

    body = chat(client, "Loop").json()

    assert body["reply"] != "(The model returned no answer.)"
    assert "search_notes" in body["reply"] and '"keel"' in body["reply"]


def test_chat_falls_back_to_reasoning_content(client, model):
    message = SimpleNamespace(content=None, tool_calls=None, reasoning_content="Thought-out answer")
    model.script.append(SimpleNamespace(choices=[SimpleNamespace(message=message)]))

    assert chat(client, "Hi").json()["reply"] == "Thought-out answer"


def test_chat_searches_local_files(client, model, tmp_path):
    (tmp_path / "Hull").mkdir()
    (tmp_path / "Hull" / "Scantlings C7801.pdf").write_bytes(b"%PDF")
    model.script += [
        reply(tool_calls=[tool_call("search_local_files", {"path": str(tmp_path), "query": "scantling"})]),
        reply("Found it"),
    ]

    body = chat(client, "Find the scantlings").json()

    assert body["tool_calls"] == [
        {"name": "search_local_files", "arguments": {"path": str(tmp_path), "query": "scantling"}, "ok": True}
    ]
    [result] = tool_results(model.calls[1])
    assert [m["name"] for m in result["matches"]] == ["Scantlings C7801.pdf"]


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
    assert offered == [
        "search_notes",
        "read_note",
        "list_tasks",
        "search_local_files",
        "list_local_directory",
        "read_local_file",
        "read_spreadsheet",
        "search_web",
        "fetch_web_page",
    ]
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


# --- Models -------------------------------------------------------------------


def test_list_models_lists_the_cli_models(client, monkeypatch):
    # Nothing is fetched from the Gemini API.
    monkeypatch.setattr(agent.urllib.request, "urlopen", lambda *args, **kwargs: pytest.fail("no API call"))

    response = client.get("/api/models")

    assert response.status_code == 200
    # The configured one first, then the Claude CLI models, then the Gemini API ones.
    assert response.json() == ["test-model", *agent.CLAUDE_CLI_MODELS, *agent.GEMINI_API_MODELS]
    assert response.json()[1:3] == ["claude-opus-5-5", "claude-sonnet-5-5"]


def test_list_models_without_api_key_and_a_cli_default(settings):
    settings.gemini_api_key = None
    settings.chat_model = "gemini/gemini-2.5-pro"

    models = agent.list_models(settings)

    assert models == ["gemini-2.5-pro", *agent.CLAUDE_CLI_MODELS, *[m for m in agent.GEMINI_API_MODELS if m != "gemini-2.5-pro"]]


def test_default_chat_model_is_claude_opus_5_5():
    assert Settings(_env_file=None).chat_model == "claude-opus-5-5"


def test_bare_model_name():
    assert agent.bare_model_name(" gemini/gemini-2.5-pro ") == "gemini-2.5-pro"
    assert agent.bare_model_name("claude/claude-opus-5-5") == "claude-opus-5-5"
    assert agent.bare_model_name("models/gemini-3-pro-preview") == "gemini-3-pro-preview"
    assert agent.bare_model_name("gemini/models/gemini-2.5-flash") == "gemini-2.5-flash"
    assert agent.bare_model_name(None) == ""


@pytest.mark.parametrize(
    ("picked", "used"),
    # Models that run on neither CLI go to litellm.
    [(None, "gemini/test-model"), ("gemini-2.0-flash", "gemini/gemini-2.0-flash"), ("gemini/gemini-1.5-pro", "gemini/gemini-1.5-pro")],
)
def test_chat_uses_the_picked_model(client, model, picked, used):
    model.script.append(reply("ok"))
    payload = {"messages": [{"role": "user", "content": "Hi"}], "model": picked}

    assert client.post("/api/chat", json=payload).status_code == 200
    assert model.calls[0]["model"] == used


@pytest.mark.parametrize("picked", ["openai/gpt-4o", "gemini 2.5", "../x"])
def test_chat_rejects_other_providers_models(client, model, picked):
    payload = {"messages": [{"role": "user", "content": "Hi"}], "model": picked}

    assert client.post("/api/chat", json=payload).status_code == 422
    assert model.calls == []


# --- RAG folders --------------------------------------------------------------


def test_space_context_names_rag_folders_without_listing_them(client, tmp_path):
    folder = tmp_path / "Lawrences Files"
    (folder / "C7801").mkdir(parents=True)
    (folder / "spec.pdf").write_bytes(b"%PDF")
    client.put("/api/spaces/1", json={"rag_folders": [str(folder)]})

    _, context = agent.space_context(1)

    assert "Configured Local Folders in this space" in context
    assert f"- `{folder}`" in context
    assert "search_local_files" in context and "list_local_directory" in context
    assert "spec.pdf" not in context and "C7801" not in context


def test_space_context_without_rag_folders(client):
    assert "Local Folders" not in agent.space_context(1)[1]


# --- Web research ---------------------------------------------------------------


class FakeResponse:
    def __init__(self, body, content_type="text/html; charset=utf-8"):
        self.body = body.encode() if isinstance(body, str) else body
        self.headers = Message()
        self.headers["Content-Type"] = content_type

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def read(self, _limit=None):
        return self.body


SEARCH_PAGE = """
<div class="result results_links web-result">
  <h2 class="result__title">
    <a rel="nofollow" class="result__a"
       href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.iso.org%2Fstandard%2F12215.html&amp;rut=abc">ISO <b>12215</b>-5</a>
  </h2>
  <a class="result__snippet" href="//duckduckgo.com/l/?uddg=x">Hull construction &mdash; <b>scantlings</b>.</a>
</div>
<div class="result">
  <a class="result__a" href="https://duckduckgo.com/y.js?ad_provider=x">Ad</a>
</div>
<div class="result">
  <a class="result__a" href="https://example.com/rcd">RCD guide</a>
  <a class="result__snippet">Recreational craft directive.</a>
</div>
"""


def test_search_web_parses_duckduckgo_results(monkeypatch):
    requests = []

    def urlopen(request, timeout):
        requests.append((request.full_url, request.get_header("User-agent"), timeout))
        return FakeResponse(SEARCH_PAGE)

    monkeypatch.setattr(agent.urllib.request, "urlopen", urlopen)

    result = agent.search_web("ISO 12215 scantlings")

    assert result == {
        "query": "ISO 12215 scantlings",
        "results": [
            {
                "title": "ISO 12215-5",
                "url": "https://www.iso.org/standard/12215.html",
                "snippet": "Hull construction — scantlings.",
            },
            {"title": "RCD guide", "url": "https://example.com/rcd", "snippet": "Recreational craft directive."},
        ],
    }
    url, user_agent, timeout = requests[0]
    assert url.startswith(agent.WEB_SEARCH_URL) and "q=ISO+12215+scantlings" in url
    assert "Mozilla" in user_agent and timeout == 10


def test_search_web_network_failure_is_a_tool_error(monkeypatch):
    def urlopen(request, timeout):
        raise OSError("offline")

    monkeypatch.setattr(agent.urllib.request, "urlopen", urlopen)

    with pytest.raises(agent.ToolError, match="offline"):
        agent.search_web("keel")


def test_fetch_web_page_extracts_readable_text(monkeypatch):
    page = (
        "<html><head><title> Keel  bolts </title><style>p {color: red}</style>"
        "<script>var secret = 1;</script></head><body><h1>Keel bolts</h1>"
        "<p>Use   316 stainless.</p><noscript>Enable JS</noscript><p>Torque to spec.</p></body></html>"
    )
    monkeypatch.setattr(agent.urllib.request, "urlopen", lambda request, timeout: FakeResponse(page))

    result = agent.fetch_web_page("https://example.com/keel")

    assert result == {
        "url": "https://example.com/keel",
        "title": "Keel bolts",
        "content": "Keel bolts\nUse 316 stainless.\nTorque to spec.",
    }


def test_fetch_web_page_truncates_long_pages(monkeypatch):
    page = "<p>" + "x" * (agent.READ_LIMIT + 50) + "</p>"
    monkeypatch.setattr(agent.urllib.request, "urlopen", lambda request, timeout: FakeResponse(page))

    content = agent.fetch_web_page("http://example.com")["content"]

    assert content.startswith("x" * agent.READ_LIMIT) and "truncated" in content


@pytest.mark.parametrize("url", ["file:///C:/secret.txt", "ftp://example.com", "C:\\notes.md", "javascript:alert(1)"])
def test_fetch_web_page_rejects_other_schemes(monkeypatch, url):
    monkeypatch.setattr(agent.urllib.request, "urlopen", lambda *a, **k: pytest.fail("must not fetch"))

    with pytest.raises(agent.ToolError, match="http"):
        agent.fetch_web_page(url)


def test_fetch_web_page_refuses_binary_content(monkeypatch):
    monkeypatch.setattr(
        agent.urllib.request, "urlopen", lambda request, timeout: FakeResponse(b"%PDF", "application/pdf")
    )

    with pytest.raises(agent.ToolError, match="application/pdf"):
        agent.fetch_web_page("https://example.com/a.pdf")


def test_chat_offers_and_runs_the_web_tools(client, model, monkeypatch):
    monkeypatch.setattr(agent.urllib.request, "urlopen", lambda request, timeout: FakeResponse(SEARCH_PAGE))
    model.script += [reply(tool_calls=[tool_call("search_web", {"query": "ISO 12215"})]), reply("Found it")]

    body = chat(client, "Research ISO 12215").json()

    offered = [t["function"]["name"] for t in model.calls[0]["tools"]]
    assert "search_web" in offered and "fetch_web_page" in offered
    assert "search_web" in model.calls[0]["messages"][0]["content"]
    assert tool_results(model.calls[1])[0]["results"][0]["url"] == "https://www.iso.org/standard/12215.html"
    assert body["tool_calls"] == [{"name": "search_web", "arguments": {"query": "ISO 12215"}, "ok": True}]


# --- Claude CLI -------------------------------------------------------------------


def cli_result(text, tool_uses=(), is_error=False):
    """The stream-json output of a CLI run that used `tool_uses` ((id, name, input, ok), ...) and answered `text`."""
    events = [{"type": "system", "subtype": "init"}]
    for call_id, name, arguments, ok in tool_uses:
        tool_use = {"type": "tool_use", "id": call_id, "name": name, "input": arguments}
        tool_result = {"type": "tool_result", "tool_use_id": call_id, "is_error": not ok}
        events.append({"type": "assistant", "message": {"content": [tool_use]}})
        events.append({"type": "user", "message": {"content": [tool_result]}})
    events.append({"type": "result", "subtype": "success", "is_error": is_error, "result": text})
    return "\n".join(json.dumps(e) for e in events) + "\n"


@pytest.fixture
def cli(monkeypatch):
    """Replace the `claude` CLI with a script of outputs, so tests never run the real one."""
    script, runs = [], []
    monkeypatch.setattr(agent.shutil, "which", lambda name: "C:/npm/claude.cmd" if name == "claude" else None)
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-should-not-leak")

    def run(cmd, **kwargs):
        runs.append({"cmd": cmd, **kwargs})
        return SimpleNamespace(stdout=script.pop(0), stderr="", returncode=0)

    monkeypatch.setattr(agent.subprocess, "run", run)
    return SimpleNamespace(script=script, runs=runs)


def cli_chat(client, text, mode="ask_first", model_name="claude-opus-4-6", **extra):
    payload = {"messages": [{"role": "user", "content": text}], "access_mode": mode, "model": model_name, **extra}
    return client.post("/api/chat", json=payload)


def test_is_claude_cli_model():
    assert agent.is_claude_cli_model("claude-opus-5-5")
    assert agent.is_claude_cli_model("claude-opus-4-6")
    assert agent.is_claude_cli_model("claude/claude-haiku-4-5")
    assert agent.is_claude_cli_model("models/claude-sonnet-4-6")
    assert not agent.is_claude_cli_model("gemini-2.5-pro")
    assert not agent.is_claude_cli_model("claude-unknown")
    assert not agent.is_claude_cli_model(None)


def test_claude_cli_needs_no_api_key(client, settings, model, cli, notes_dir):
    settings.gemini_api_key = None
    cli.script.append(
        cli_result(
            "ISO 12215-5 covers scantlings. Source: https://www.iso.org",
            [("t1", "WebSearch", {"query": "ISO 12215"}, True), ("t2", "Read", {"file_path": "C:/x.md"}, False)],
        )
    )

    response = cli_chat(client, "Research ISO 12215", model_name="claude-sonnet-5-5", reasoning_effort="high")

    assert response.status_code == 200
    body = response.json()
    assert body["reply"] == "ISO 12215-5 covers scantlings. Source: https://www.iso.org"
    assert body["tool_calls"] == [
        {"name": "WebSearch", "arguments": {"query": "ISO 12215"}, "ok": True},
        {"name": "Read", "arguments": {"file_path": "C:/x.md"}, "ok": False},
    ]
    assert model.calls == []  # litellm is not used

    run = cli.runs[0]
    cmd = run["cmd"]
    assert cmd[:2] == ["C:/npm/claude.cmd", "-p"]
    assert cmd[cmd.index("--model") + 1] == "sonnet"
    assert cmd[cmd.index("--output-format") + 1] == "stream-json"
    assert cmd[cmd.index("--tools") + 1] == "Read,Glob,Grep,WebSearch,WebFetch"
    assert cmd[cmd.index("--add-dir") + 1] == str(notes_dir.resolve())
    assert cmd[cmd.index("--effort") + 1] == "high"
    assert {"--verbose", "--no-session-persistence", "--dangerously-skip-permissions"} <= set(cmd)
    # The prompt goes on stdin, never on the command line.
    assert "Research ISO 12215" in run["input"] and not any("Research ISO 12215" in arg for arg in cmd)
    assert str(notes_dir.resolve()) in run["input"]
    assert "ANTHROPIC_API_KEY" not in run["env"]


def test_claude_cli_is_used_as_the_configured_default(client, settings, model, cli):
    settings.chat_model = "claude-haiku-4-5"
    cli.script.append(cli_result("Hi"))

    assert client.post("/api/chat", json={"messages": [{"role": "user", "content": "Hi"}]}).json()["reply"] == "Hi"
    cmd = cli.runs[0]["cmd"]
    assert cmd[cmd.index("--model") + 1] == "haiku"
    assert "--effort" not in cmd


def test_claude_cli_prompt_has_tasks_history_and_rag_folders(client, cli, tmp_path):
    rag = tmp_path / "Design data"
    rag.mkdir()
    client.put("/api/spaces/1", json={"rag_folders": [str(rag), str(tmp_path / "missing")]})
    with database.SessionLocal() as session:
        project = Project(code="C7801", name="Sport 40")
        session.add(project)
        session.flush()
        session.add(Task(title="Lay up hull", project_id=project.id, space_id=1, status=Status.IN_PROGRESS))
        session.commit()
    cli.script.append(cli_result("ok"))
    payload = {
        "messages": [
            {"role": "user", "content": "First question"},
            {"role": "assistant", "content": "First answer"},
            {"role": "user", "content": "Follow-up"},
        ],
        "model": "claude-opus-4-6",
        "access_mode": "read_only",
    }

    assert client.post("/api/chat", json=payload).status_code == 200

    prompt, cmd = cli.runs[0]["input"], cli.runs[0]["cmd"]
    assert "Lay up hull" in prompt and "C7801" in prompt
    assert prompt.index("First question") < prompt.index("First answer") < prompt.index("Follow-up")
    assert "READ ONLY" in prompt and "<write_note" not in prompt
    add_dirs = [cmd[i + 1] for i, arg in enumerate(cmd) if arg == "--add-dir"]
    assert str(rag) in add_dirs and str(tmp_path / "missing") not in add_dirs


def test_claude_cli_write_note_block_is_proposed_in_ask_first(client, notes_dir, cli):
    cli.script.append(
        cli_result(
            "Here is the report.\n\n"
            '<write_note path="C7801/Report.md">\n---\ntype: report\nproject: C7801\n---\n# Keel\n\nBolts: 316.\n'
            "</write_note>\n\nApprove it to save."
        )
    )

    body = cli_chat(client, "Write a report").json()

    assert body["reply"] == "Here is the report.\n\nApprove it to save."
    assert body["written_paths"] == []
    assert [(e["path"], e["content"], e["frontmatter"]) for e in body["proposed_edits"]] == [
        ("C7801/Report.md", "# Keel\n\nBolts: 316.", {"type": "report", "project": "C7801"})
    ]
    assert body["tool_calls"] == [{"name": "write_note", "arguments": {"path": "C7801/Report.md"}, "ok": True}]
    assert not (notes_dir / "C7801" / "Report.md").exists()
    assert "ASK FIRST" in cli.runs[0]["input"] and "<write_note" in cli.runs[0]["input"]


def test_claude_cli_write_note_block_writes_directly(client, notes_dir, cli):
    cli.script.append(cli_result('<write_note path="Inbox/Idea.md">\nJust a body\n</write_note>'))

    body = cli_chat(client, "Save an idea", mode="write_directly").json()

    assert body["written_paths"] == ["Inbox/Idea.md"]
    assert body["reply"] == "- Wrote `Inbox/Idea.md`."
    assert file_layer.read_note("Inbox/Idea.md")["content"] == "Just a body"
    assert note_history() == [("Inbox/Idea.md", "create", "copilot_agent")]


@pytest.mark.parametrize(("mode", "path"), [("read_only", "Inbox/x.md"), ("write_directly", "../evil.md")])
def test_claude_cli_write_note_block_refused(client, notes_dir, cli, mode, path):
    cli.script.append(cli_result(f'Done.\n<write_note path="{path}">\nx\n</write_note>'))

    body = cli_chat(client, "Write", mode=mode).json()

    assert body["written_paths"] == [] and body["proposed_edits"] == []
    assert body["tool_calls"] == [{"name": "write_note", "arguments": {"path": path}, "ok": False}]
    assert body["reply"].startswith("Done.\n\n- Could not write")
    assert "<write_note" not in body["reply"]


def test_claude_cli_not_installed(client, model, monkeypatch):
    monkeypatch.setattr(agent.shutil, "which", lambda name: None)

    response = cli_chat(client, "Hi")

    assert response.status_code == 503
    assert "Claude CLI" in response.json()["detail"]


def test_claude_cli_failure(client, cli):
    cli.script.append(cli_result("Not logged in", is_error=True))

    response = cli_chat(client, "Hi")

    assert response.status_code == 502
    assert "Not logged in" in response.json()["detail"]


def test_claude_cli_without_result(client, monkeypatch):
    monkeypatch.setattr(agent.shutil, "which", lambda name: "claude")
    monkeypatch.setattr(
        agent.subprocess, "run", lambda cmd, **kwargs: SimpleNamespace(stdout="", stderr="boom", returncode=1)
    )

    response = cli_chat(client, "Hi")

    assert response.status_code == 502
    assert "boom" in response.json()["detail"]


@pytest.mark.parametrize("picked", ["claude-opus-5-5", "claude-opus-4-6", "claude/claude-sonnet-4-6"])
def test_chat_accepts_claude_models(client, cli, picked):
    cli.script.append(cli_result("ok"))

    assert cli_chat(client, "Hi", model_name=picked).status_code == 200


def test_claude_cli_passes_full_ids_for_older_models(client, cli):
    cli.script.append(cli_result("ok"))

    assert cli_chat(client, "Hi", model_name="claude-opus-4-6").status_code == 200
    cmd = cli.runs[0]["cmd"]
    assert cmd[cmd.index("--model") + 1] == "claude-opus-4-6"


# --- Gemini CLI ---------------------------------------------------------------


def gemini_events(text_chunks, tools=(), result_status="success"):
    """The `gemini -o stream-json` output for a turn: tool calls, then the reply streamed in delta chunks."""
    events = [{"type": "init", "session_id": "s1", "model": "gemini-2.5-pro"}]
    for tool_id, name, parameters, status in tools:
        events.append({"type": "tool_use", "tool_name": name, "tool_id": tool_id, "parameters": parameters})
        events.append({"type": "tool_result", "tool_id": tool_id, "status": status, "output": "..."})
    for chunk in text_chunks:
        events.append({"type": "message", "role": "assistant", "content": chunk, "delta": True})
    events.append({"type": "result", "status": result_status, "stats": {}})
    return "\n".join(json.dumps(e) for e in events) + "\n"


@pytest.fixture
def gemini(monkeypatch):
    """Replace the `gemini` CLI with a script of (stdout, stderr, returncode), so tests never run the real one."""
    script, runs = [], []
    monkeypatch.setattr(agent.shutil, "which", lambda name: "C:/npm/gemini.cmd" if name == "gemini" else None)
    monkeypatch.setenv("GEMINI_API_KEY", "gemini-should-not-leak")
    monkeypatch.setenv("GOOGLE_API_KEY", "google-should-not-leak")

    def run(cmd, **kwargs):
        runs.append({"cmd": cmd, **kwargs})
        stdout, stderr, returncode = script.pop(0)
        return SimpleNamespace(stdout=stdout, stderr=stderr, returncode=returncode)

    monkeypatch.setattr(agent.subprocess, "run", run)
    return SimpleNamespace(script=script, runs=runs)


def test_is_gemini_cli_model():
    assert agent.is_gemini_cli_model("gemini-2.5-pro")
    assert agent.is_gemini_cli_model("gemini-3-pro-preview")
    assert not agent.is_gemini_cli_model("gemini/gemini-3.1-pro-preview")
    assert not agent.is_gemini_cli_model("gemini-3.8-flash")
    assert agent.is_gemini_cli_model("models/gemini-3.5-flash-lite")
    assert not agent.is_gemini_cli_model("gemini-2.0-flash")
    assert not agent.is_gemini_cli_model("claude-opus-5-5")
    assert not agent.is_gemini_cli_model(None)


def test_gemini_env_strips_api_keys_and_forces_google_sign_in(monkeypatch):
    monkeypatch.setenv("GEMINI_API_KEY", "x")
    monkeypatch.setenv("GOOGLE_API_KEY", "y")
    monkeypatch.setenv("GOOGLE_GENAI_USE_GCA", "false")

    env = agent._gemini_env()

    assert "GEMINI_API_KEY" not in env and "GOOGLE_API_KEY" not in env
    assert env["GOOGLE_GENAI_USE_GCA"] == "true"


def test_parse_gemini_stream():
    stdout = (
        "not json\n"
        + gemini_events(
            ["ISO 12215-5 ", "covers scantlings."],
            [("t1", "google_web_search", {"query": "ISO 12215"}, "success"), ("t2", "read_file", {"path": "x"}, "error")],
        )
        + json.dumps({"type": "message", "role": "user", "content": "ignored"})
    )

    reply, error, calls = agent._parse_gemini_stream(stdout)

    assert reply == "ISO 12215-5 covers scantlings."
    assert error is None
    assert [(c.name, c.arguments, c.ok) for c in calls] == [
        ("google_web_search", {"query": "ISO 12215"}, True),
        ("read_file", {"path": "x"}, False),
    ]


def test_parse_gemini_stream_breaks_paragraphs_between_turns():
    events = [
        {"type": "message", "role": "assistant", "content": "I will check the files.", "delta": True},
        {"type": "tool_use", "tool_name": "read_file", "tool_id": "t1", "parameters": {"path": "x"}},
        {"type": "tool_result", "tool_id": "t1", "status": "success", "output": "..."},
        {"type": "message", "role": "assistant", "content": "### Heading", "delta": True},
        {"type": "message", "role": "assistant", "content": "\n", "delta": True},
        {"type": "thought", "subject": "Listing", "description": "..."},
        {"type": "message", "role": "assistant", "content": "* List", "delta": True},
        {"type": "thought", "subject": "Done", "description": "..."},
        {"type": "message", "role": "assistant", "content": "\n\nEnd", "delta": True},
    ]

    reply, _error, _calls = agent._parse_gemini_stream("\n".join(json.dumps(e) for e in events))

    assert reply == "I will check the files.\n\n### Heading\n\n* List\n\nEnd"


def test_parse_gemini_stream_errors():
    _reply, error, _calls = agent._parse_gemini_stream(
        json.dumps({"type": "result", "status": "error", "error": {"type": "Error", "message": "Quota exceeded"}})
    )
    assert error == "Quota exceeded"
    _reply, error, _calls = agent._parse_gemini_stream(json.dumps({"type": "error", "message": "Model not found"}))
    assert error == "Model not found"


def test_gemini_cli_needs_no_api_key(client, settings, model, gemini, notes_dir, tmp_path):
    settings.gemini_api_key = None
    rag = tmp_path / "Design data"
    rag.mkdir()
    client.put("/api/spaces/1", json={"rag_folders": [str(rag), str(tmp_path / "missing")]})
    gemini.script.append(
        (gemini_events(["Hull ", "is GRP."], [("t1", "read_file", {"absolute_path": "C:/x.md"}, "success")]), "", 0)
    )
    payload = {
        "messages": [{"role": "user", "content": "What is the hull made of?"}],
        "model": "gemini-2.5-pro",
        "reasoning_effort": "high",
    }

    response = client.post("/api/chat", json=payload)

    assert response.status_code == 200
    body = response.json()
    assert body["reply"] == "Hull is GRP."
    assert body["tool_calls"] == [{"name": "read_file", "arguments": {"absolute_path": "C:/x.md"}, "ok": True}]
    assert model.calls == []  # litellm is not used

    run = gemini.runs[0]
    cmd = run["cmd"]
    assert cmd[:3] == ["C:/npm/gemini.cmd", "-p", agent.GEMINI_CLI_PROMPT]
    assert cmd[cmd.index("-m") + 1] == "gemini-2.5-pro"
    assert cmd[cmd.index("-o") + 1] == "stream-json"
    assert {"--skip-trust", "--yolo"} <= set(cmd)
    dirs = [cmd[i + 1] for i, arg in enumerate(cmd) if arg == "--include-directories"]
    assert dirs == [str(notes_dir.resolve()), str(rag)]
    # The prompt goes on stdin, never on the command line.
    assert "What is the hull made of?" in run["input"] and not any("hull made" in arg for arg in cmd)
    assert "google_web_search" in run["input"] and str(notes_dir.resolve()) in run["input"]
    assert "GEMINI_API_KEY" not in run["env"] and "GOOGLE_API_KEY" not in run["env"]
    assert run["env"]["GOOGLE_GENAI_USE_GCA"] == "true"


def test_gemini_cli_is_used_as_the_configured_default(client, settings, model, gemini):
    settings.chat_model = "gemini/gemini-2.5-pro"
    gemini.script.append((gemini_events(["Hi"]), "", 0))

    assert client.post("/api/chat", json={"messages": [{"role": "user", "content": "Hi"}]}).json()["reply"] == "Hi"
    cmd = gemini.runs[0]["cmd"]
    assert cmd[cmd.index("-m") + 1] == "gemini-2.5-pro"
    assert model.calls == []


def test_gemini_cli_retired_model_is_aliased(client, settings, model, gemini):
    settings.chat_model = "gemini/gemini-3.5-flash-lite"
    gemini.script.append((gemini_events(["Hi"]), "", 0))

    assert client.post("/api/chat", json={"messages": [{"role": "user", "content": "Hi"}]}).json()["reply"] == "Hi"
    cmd = gemini.runs[0]["cmd"]
    assert cmd[cmd.index("-m") + 1] == "gemini-2.5-flash-lite"
    assert model.calls == []



def test_gemini_cli_write_note_block_is_proposed_in_ask_first(client, notes_dir, gemini):
    # The block arrives split across delta chunks.
    chunks = ["Here is the report.\n\n<write_note path=\"C7801/Report.md\">\n---\ntype: re", "port\n---\n# Keel\n", "</write_note>"]
    gemini.script.append((gemini_events(chunks), "", 0))

    body = cli_chat(client, "Write a report", model_name="gemini-2.5-flash").json()

    assert body["reply"] == "Here is the report."
    assert [(e["path"], e["content"], e["frontmatter"]) for e in body["proposed_edits"]] == [
        ("C7801/Report.md", "# Keel", {"type": "report"})
    ]
    assert body["tool_calls"] == [{"name": "write_note", "arguments": {"path": "C7801/Report.md"}, "ok": True}]
    assert not (notes_dir / "C7801" / "Report.md").exists()
    assert "ASK FIRST" in gemini.runs[0]["input"]


def test_gemini_cli_write_note_block_writes_directly(client, notes_dir, gemini):
    gemini.script.append((gemini_events(['<write_note path="Inbox/Idea.md">\nJust a body\n</write_note>']), "", 0))

    body = cli_chat(client, "Save an idea", mode="write_directly", model_name="gemini-2.5-pro").json()

    assert body["written_paths"] == ["Inbox/Idea.md"]
    assert body["reply"] == "- Wrote `Inbox/Idea.md`."
    assert file_layer.read_note("Inbox/Idea.md")["content"] == "Just a body"


def test_gemini_cli_write_note_block_refused_in_read_only(client, gemini):
    gemini.script.append((gemini_events(['Done.\n<write_note path="Inbox/x.md">\nx\n</write_note>']), "", 0))

    body = cli_chat(client, "Write", mode="read_only", model_name="gemini-2.5-pro").json()

    assert body["written_paths"] == [] and body["proposed_edits"] == []
    assert body["tool_calls"] == [{"name": "write_note", "arguments": {"path": "Inbox/x.md"}, "ok": False}]
    assert body["reply"].startswith("Done.\n\n- Could not write")
    assert "READ ONLY" in gemini.runs[0]["input"]


def test_gemini_cli_not_installed(client, model, monkeypatch):
    monkeypatch.setattr(agent.shutil, "which", lambda name: None)

    response = cli_chat(client, "Hi", model_name="gemini-2.5-pro")

    assert response.status_code == 503
    assert "Gemini CLI" in response.json()["detail"]
    assert model.calls == []


@pytest.mark.parametrize(
    ("stdout", "stderr"),
    [
        ("", "Opening authentication page in your browser."),
        ("", "Please set an Auth method in your settings.json"),
        ('{"type": "error", "message": "Authentication cancelled"}\n', ""),
    ],
)
def test_gemini_cli_not_signed_in(client, gemini, stdout, stderr):
    gemini.script.append((stdout, stderr, 41))

    response = cli_chat(client, "Hi", model_name="gemini-2.5-pro")

    assert response.status_code == 503
    assert "Login with Google" in response.json()["detail"]


def test_gemini_cli_failure(client, gemini):
    gemini.script.append((gemini_events([]) + json.dumps({"type": "error", "message": "boom"}), "", 0))

    response = cli_chat(client, "Hi", model_name="gemini-2.5-pro")

    assert response.status_code == 502
    assert "boom" in response.json()["detail"]


def test_gemini_cli_nonzero_exit(client, gemini):
    gemini.script.append(("", "Unknown model", 1))

    response = cli_chat(client, "Hi", model_name="gemini-2.5-pro")

    assert response.status_code == 502
    assert "Unknown model" in response.json()["detail"]


# --- Streaming (POST /api/chat/stream) ----------------------------------------


def stream(client, text, mode="ask_first", **extra):
    payload = {"messages": [{"role": "user", "content": text}], "access_mode": mode, **extra}
    response = client.post("/api/chat/stream", json=payload)
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("application/x-ndjson")
    return [json.loads(line) for line in response.text.splitlines() if line.strip()]


def kinds(events):
    return [e["type"] for e in events]


def test_chat_stream_reports_tool_calls_as_they_run(client, notes_dir, model):
    file_layer.write_note("C7801/Keel.md", "We chose a lead keel.", {}, "write_directly")
    model.script += [
        reply(tool_calls=[tool_call("search_notes", {"query": "keel"})]),
        reply(tool_calls=[tool_call("write_note", {"path": "C7801/Bolts.md", "content": "316"}, "call-2")]),
        reply("Done (C7801/Keel.md)."),
    ]

    events = stream(client, "Keel?", mode="write_directly")

    assert events[:4] == [
        {"type": "tool_start", "id": "call-1", "name": "search_notes", "arguments": {"query": "keel"}},
        {"type": "tool_end", "id": "call-1", "name": "search_notes", "ok": True},
        # Note bodies are left out, as in the tool call summaries.
        {"type": "tool_start", "id": "call-2", "name": "write_note", "arguments": {"path": "C7801/Bolts.md"}},
        {"type": "tool_end", "id": "call-2", "name": "write_note", "ok": True},
    ]
    assert kinds(events) == ["tool_start", "tool_end", "tool_start", "tool_end", "done"]
    response = events[-1]["response"]
    assert response["reply"] == "Done (C7801/Keel.md)."
    assert response["written_paths"] == ["C7801/Bolts.md"]
    assert [c["name"] for c in response["tool_calls"]] == ["search_notes", "write_note"]


def test_chat_stream_reports_failed_tools(client, model):
    model.script += [reply(tool_calls=[tool_call("read_note", "not json")]), reply("Sorry.")]

    events = stream(client, "Hi")

    assert events[0] == {"type": "tool_start", "id": "call-1", "name": "read_note", "arguments": {}}
    assert events[1] == {"type": "tool_end", "id": "call-1", "name": "read_note", "ok": False}


def test_chat_stream_errors_are_events(client, settings, model, monkeypatch):
    key, settings.gemini_api_key = settings.gemini_api_key, None
    assert stream(client, "Hi") == [
        {"type": "error", "detail": "COPILOT_GEMINI_API_KEY is not set; add it to backend/.env", "status_code": 503}
    ]

    def completion(**_kwargs):
        raise RuntimeError("quota exceeded")

    settings.gemini_api_key = key
    monkeypatch.setattr(agent.litellm, "completion", completion)
    [event] = stream(client, "Hi")
    assert event["type"] == "error" and event["status_code"] == 502 and "quota exceeded" in event["detail"]


def test_chat_stream_unknown_space(client, model):
    payload = {"messages": [{"role": "user", "content": "Hi"}], "space_id": 999}
    assert client.post("/api/chat/stream", json=payload).status_code == 404


class FakeStdin(io.StringIO):
    def close(self):
        self.text = self.getvalue()
        super().close()


class FakeProcess:
    """A `subprocess.Popen` of a CLI printing `stdout`; with `block`, it then hangs until killed."""

    def __init__(self, stdout, stderr="", returncode=0, block=False):
        self.lines = queue.Queue()
        for line in stdout.splitlines(keepends=True):
            self.lines.put(line)
        if not block:
            self.lines.put("")
        self.stdin = FakeStdin()
        self.stdout = SimpleNamespace(readline=self.lines.get)
        self.stderr = io.StringIO(stderr)
        self.pid, self.returncode, self.exit_code, self.killed = 4321, None, returncode, False

    def poll(self):
        return self.returncode

    def wait(self):
        self.returncode = self.exit_code
        return self.returncode

    def terminate(self):
        self.kill()

    def kill(self):
        if not self.killed:
            self.killed, self.returncode = True, -9
            self.lines.put("")  # its stdout closes


@pytest.fixture
def popen(monkeypatch):
    """Replace `subprocess.Popen` with a script of `FakeProcess`es, so streaming tests never run a real CLI."""
    script, runs, taskkills = [], [], []
    monkeypatch.setattr(agent.shutil, "which", lambda name: f"C:/npm/{name}.cmd" if name in ("claude", "gemini") else None)
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-should-not-leak")
    monkeypatch.setenv("GEMINI_API_KEY", "gemini-should-not-leak")

    def start(cmd, **kwargs):
        process = script.pop(0)
        runs.append({"cmd": cmd, "process": process, **kwargs})
        return process

    monkeypatch.setattr(agent.subprocess, "Popen", start)
    monkeypatch.setattr(agent.subprocess, "run", lambda cmd, **kwargs: taskkills.append(cmd))
    return SimpleNamespace(script=script, runs=runs, taskkills=taskkills)


def claude_line(kind, *content):
    return json.dumps({"type": kind, "message": {"content": list(content)}}) + "\n"


def test_chat_stream_claude_cli_events(client, notes_dir, popen):
    result = 'A lead keel.\n<write_note path="C7801/Keel.md">\n# Keel\n</write_note>'
    stdout = (
        json.dumps({"type": "system", "subtype": "init"})
        + "\n"
        + claude_line("assistant", {"type": "thinking", "thinking": "  Look for the keel note.  "})
        + claude_line("assistant", {"type": "text", "text": "Searching."})
        + claude_line("assistant", {"type": "tool_use", "id": "t1", "name": "Grep", "input": {"pattern": "keel"}})
        + claude_line("user", {"type": "tool_result", "tool_use_id": "t1", "is_error": False})
        + claude_line("assistant", {"type": "tool_use", "id": "t2", "name": "Read", "input": {"file_path": "x.md"}})
        + claude_line("user", {"type": "tool_result", "tool_use_id": "t2", "is_error": True})
        + json.dumps({"type": "result", "is_error": False, "result": result})
        + "\n"
    )
    popen.script.append(FakeProcess(stdout))

    events = stream(client, "Keel?", model="claude-opus-4-6")

    assert events[:7] == [
        {"type": "thought", "subject": None, "text": "Look for the keel note."},
        {"type": "text_delta", "delta": "Searching."},
        {"type": "tool_start", "id": "t1", "name": "Grep", "arguments": {"pattern": "keel"}},
        {"type": "tool_end", "id": "t1", "name": "Grep", "ok": True},
        {"type": "tool_start", "id": "t2", "name": "Read", "arguments": {"file_path": "x.md"}},
        {"type": "tool_end", "id": "t2", "name": "Read", "ok": False},
        # The reply's note block, carried out (here proposed) once the CLI is done.
        {"type": "tool_start", "id": "write_note-0", "name": "write_note", "arguments": {"path": "C7801/Keel.md"}},
    ]
    assert kinds(events)[7:] == ["tool_end", "done"]
    response = events[-1]["response"]
    assert response["reply"] == "A lead keel."
    assert [e["path"] for e in response["proposed_edits"]] == ["C7801/Keel.md"]
    assert [(c["name"], c["ok"]) for c in response["tool_calls"]] == [("Grep", True), ("Read", False), ("write_note", True)]
    [run] = popen.runs
    assert run["cmd"][0] == "C:/npm/claude.cmd" and "stream-json" in run["cmd"]
    assert "ANTHROPIC_API_KEY" not in run["env"]
    assert "Keel?" in run["process"].stdin.text
    assert not run["process"].killed and popen.taskkills == []


def test_chat_stream_claude_cli_failure(client, popen):
    popen.script.append(FakeProcess(json.dumps({"type": "result", "is_error": True, "result": "Overloaded"}) + "\n"))

    [event] = stream(client, "Hi", model="claude-opus-4-6")

    assert event == {"type": "error", "detail": "The Claude CLI failed: Overloaded", "status_code": 502}


def test_chat_stream_claude_cli_not_installed(client, popen, monkeypatch):
    monkeypatch.setattr(agent.shutil, "which", lambda name: None)

    [event] = stream(client, "Hi", model="claude-opus-4-6")

    assert event["type"] == "error" and event["status_code"] == 503


def test_chat_stream_gemini_cli_events(client, popen):
    thought = {"type": "thought", "subject": "Finding the standard", "description": "Search ISO 12215."}
    stdout = (
        "Loaded cached credentials.\n"
        + json.dumps(thought)
        + "\n"
        + gemini_events(
            ["ISO 12215-5 ", "covers scantlings."],
            [("g1", "google_web_search", {"query": "ISO 12215"}, "success"), ("g2", "read_file", {"path": "x"}, "error")],
        )
    )
    popen.script.append(FakeProcess(stdout))

    events = stream(client, "Which standard?", model="gemini-2.5-pro")

    assert events[:-1] == [
        {"type": "thought", "subject": "Finding the standard", "text": "Search ISO 12215."},
        {"type": "tool_start", "id": "g1", "name": "google_web_search", "arguments": {"query": "ISO 12215"}},
        {"type": "tool_end", "id": "g1", "name": "google_web_search", "ok": True},
        {"type": "tool_start", "id": "g2", "name": "read_file", "arguments": {"path": "x"}},
        {"type": "tool_end", "id": "g2", "name": "read_file", "ok": False},
        {"type": "text_delta", "delta": "ISO 12215-5 "},
        {"type": "text_delta", "delta": "covers scantlings."},
    ]
    assert events[-1]["type"] == "done"
    assert events[-1]["response"]["reply"] == "ISO 12215-5 covers scantlings."
    [run] = popen.runs
    assert "GEMINI_API_KEY" not in run["env"] and run["env"]["GOOGLE_GENAI_USE_GCA"] == "true"
    assert "Which standard?" in run["process"].stdin.text


@pytest.mark.parametrize(
    ("stdout", "stderr", "returncode", "status_code", "detail"),
    [
        ("", "Please set an Auth method in your settings.json", 41, 503, "Login with Google"),
        ('{"type": "error", "message": "Authentication cancelled"}\n', "", 41, 503, "Login with Google"),
        (gemini_events([]) + json.dumps({"type": "error", "message": "boom"}) + "\n", "", 0, 502, "boom"),
        ("", "Unknown model", 1, 502, "Unknown model"),
    ],
)
def test_chat_stream_gemini_cli_failures(client, popen, stdout, stderr, returncode, status_code, detail):
    popen.script.append(FakeProcess(stdout, stderr, returncode))

    [event] = stream(client, "Hi", model="gemini-2.5-pro")

    assert event["type"] == "error" and event["status_code"] == status_code
    assert detail in event["detail"]


def hanging_claude(popen):
    """A Claude CLI that starts a tool call, then hangs."""
    tool_use = {"type": "tool_use", "id": "t1", "name": "Glob", "input": {"pattern": "**/*.pdf"}}
    process = FakeProcess(claude_line("assistant", tool_use), block=True)
    popen.script.append(process)
    return process


def test_stream_cancel_kills_the_cli_and_ends_the_turn(client, popen):
    process = hanging_claude(popen)
    cancel = agent.StreamCancel()
    messages = [ChatMessage(role="user", content="Find the PDFs")]
    events = agent.stream_chat(messages, AccessMode.READ_ONLY, model="claude-opus-4-6", cancel=cancel)

    assert next(events)["type"] == "tool_start"
    cancel.cancel()  # Stop, while the turn waits on the CLI

    assert list(events) == []  # neither done nor an error
    assert process.killed


def test_closing_the_stream_kills_the_cli(client, popen):
    process = hanging_claude(popen)
    messages = [ChatMessage(role="user", content="Find the PDFs")]
    events = agent.stream_chat(messages, AccessMode.READ_ONLY, model="claude-opus-4-6")

    assert next(events)["type"] == "tool_start"
    events.close()

    assert process.killed


def test_terminate_process_kills_the_tree_on_windows(popen, monkeypatch):
    monkeypatch.setattr(agent.os, "name", "nt")
    process = FakeProcess("", block=True)

    agent._terminate_process(process)

    assert popen.taskkills == [["taskkill", "/F", "/T", "/PID", "4321"]]
    assert process.killed


def test_chat_stream_cli_timeout(client, popen, monkeypatch):
    process = hanging_claude(popen)
    monkeypatch.setattr(agent, "CLAUDE_CLI_TIMEOUT_SECONDS", 0.05)

    events = stream(client, "Find the PDFs", model="claude-opus-4-6")

    assert kinds(events) == ["tool_start", "error"]
    assert events[-1]["status_code"] == 502 and "did not answer within" in events[-1]["detail"]
    assert process.killed
