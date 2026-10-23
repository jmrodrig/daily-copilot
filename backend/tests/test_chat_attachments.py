import json
from types import SimpleNamespace

import pymupdf
import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

import agent
import main
from config import Settings
from schemas import ChatAttachment, ChatMessage, ChatRequest


@pytest.fixture
def settings(monkeypatch):
    settings = Settings(_env_file=None, gemini_api_key="test-key", chat_model="gemini/test-model")
    monkeypatch.setattr(agent, "get_settings", lambda: settings)
    return settings


@pytest.fixture
def client(notes_dir, settings, monkeypatch):
    monkeypatch.setattr(main, "init_db", lambda: None)
    with TestClient(main.app) as client:
        yield client


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
def cli(monkeypatch):
    """Replace the `claude` CLI with a script of outputs, so tests never run the real one."""
    script, runs = [], []
    monkeypatch.setattr(agent.shutil, "which", lambda name: "C:/npm/claude.cmd" if name == "claude" else None)

    def run(cmd, **kwargs):
        runs.append({"cmd": cmd, **kwargs})
        return SimpleNamespace(stdout=script.pop(0), stderr="", returncode=0)

    monkeypatch.setattr(agent.subprocess, "run", run)
    return SimpleNamespace(script=script, runs=runs)


def cli_result(text):
    events = [{"type": "system", "subtype": "init"}, {"type": "result", "subtype": "success", "result": text}]
    return "\n".join(json.dumps(e) for e in events) + "\n"


def reply(content):
    return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content=content, tool_calls=None))])


def upload(client, name, data, content_type):
    response = client.post("/api/notes/image", files={"file": (name, data, content_type)}, data={"space_id": "1"})
    assert response.status_code == 200
    return {"name": name, "url": response.json()["url"], "size": len(data), "content_type": content_type}


def pdf_bytes(*pages):
    doc = pymupdf.open()
    for text in pages:
        doc.new_page().insert_text((72, 72), text)
    data = doc.tobytes()
    doc.close()
    return data


# --- Schemas ------------------------------------------------------------------


def test_chat_message_attachments_default_to_empty():
    assert ChatMessage(role="user", content="Hi").attachments == []


def test_chat_message_keeps_attachments():
    message = ChatMessage(
        role="user",
        content="See this",
        attachments=[{"name": "a.pdf", "url": "/api/notes/image/x.pdf?space_id=1", "size": 10}],
    )
    assert message.attachments == [ChatAttachment(name="a.pdf", url="/api/notes/image/x.pdf?space_id=1", size=10)]


def test_chat_request_accepts_an_attachment_without_text():
    attachment = {"name": "a.pdf", "url": "/api/notes/image/x.pdf?space_id=1"}
    request = ChatRequest(messages=[{"role": "user", "content": " ", "attachments": [attachment]}])
    assert request.messages[0].attachments[0].name == "a.pdf"


def test_chat_request_still_rejects_a_blank_message_without_attachments():
    with pytest.raises(ValidationError):
        ChatRequest(messages=[{"role": "user", "content": "  "}])


# --- Prompt construction ------------------------------------------------------


def test_text_attachment_is_embedded_with_its_local_path(client, notes_dir):
    attachment = upload(client, "loads.csv", b"part,kg\nkeel,1200\n", "text/csv")
    message = ChatMessage(role="user", content="Sum the loads", attachments=[attachment])

    text = agent._message_text(message, notes_dir)

    asset = attachment["url"].split("/api/notes/image/")[1].split("?")[0]
    assert text.startswith("Sum the loads\n\n")
    assert f'[Attached file: "loads.csv" (size: 18 bytes, local path: {(notes_dir / ".assets" / asset).resolve()})]' in text
    # A CSV comes as a table, its rows numbered as in a spreadsheet (see read_spreadsheet).
    assert "| # | part | kg |" in text and "| 2 | keel | 1200 |" in text


def test_pdf_attachment_text_is_extracted(client, notes_dir):
    attachment = upload(client, "report.pdf", pdf_bytes("Hull scantlings", "Rudder stock"), "application/pdf")

    text = agent._message_text(ChatMessage(role="user", content="Summarise", attachments=[attachment]), notes_dir)

    assert '[Attached file: "report.pdf"' in text
    assert "--- Page 1 ---" in text and "Hull scantlings" in text and "Rudder stock" in text


def test_image_attachment_gets_only_its_path(client, notes_dir):
    attachment = upload(client, "deck.png", b"\x89PNG\r\n\x1a\nfake", "image/png")

    text = agent._message_text(ChatMessage(role="user", content="What is this?", attachments=[attachment]), notes_dir)

    assert '[Attached file: "deck.png"' in text and "local path:" in text
    assert "<attachment_content" not in text


@pytest.mark.parametrize(
    "url",
    [
        "/api/notes/image/0123456789abcdef0123456789abcdef.pdf?space_id=1",  # well-formed, but not stored
        "/api/notes/image/..%2F..%2Fsecrets.txt?space_id=1",  # not an asset name
        "https://example.com/file.pdf",  # not an asset URL
    ],
)
def test_missing_or_foreign_attachment_is_named_but_not_read(notes_dir, url):
    text = agent._message_text(ChatMessage(role="user", content="Hi", attachments=[{"name": "x", "url": url}]), notes_dir)

    assert "not found in this space's files" in text and "local path" not in text


def test_litellm_turn_sends_attachments_to_the_model(client, model):
    attachment = upload(client, "notes.md", b"# Keel\nBolts: 316 stainless", "text/markdown")
    model.script.append(reply("They are 316 stainless."))
    payload = {"messages": [{"role": "user", "content": "Which bolts?", "attachments": [attachment]}]}

    assert client.post("/api/chat", json=payload).json()["reply"] == "They are 316 stainless."
    user_message = model.calls[0]["messages"][-1]
    assert user_message["role"] == "user"
    assert "Which bolts?" in user_message["content"] and "Bolts: 316 stainless" in user_message["content"]


def test_claude_cli_prompt_includes_attachment_paths_and_content(client, cli):
    attachment = upload(client, "spec.pdf", pdf_bytes("Displacement 9.2 t"), "application/pdf")
    cli.script.append(cli_result("9.2 t"))
    payload = {
        "messages": [{"role": "user", "content": "What is the displacement?", "attachments": [attachment]}],
        "model": "claude-opus-4-6",
    }

    assert client.post("/api/chat", json=payload).json()["reply"] == "9.2 t"
    prompt = cli.runs[0]["input"]
    assert '[Attached file: "spec.pdf"' in prompt and ".assets" in prompt
    assert "Displacement 9.2 t" in prompt
    assert prompt.index("What is the displacement?") < prompt.index("Displacement 9.2 t")


# --- History ------------------------------------------------------------------


def test_chat_history_round_trips_attachments(client):
    attachment = {"name": "a.pdf", "url": "/api/notes/image/x.pdf?space_id=1", "size": 1234, "content_type": "application/pdf"}
    thread = {
        "id": "t-1",
        "title": "Report",
        "createdAt": 1,
        "updatedAt": 2,
        "entries": [{"role": "user", "content": "See this", "attachments": [attachment]}],
    }

    assert client.put("/api/chat/history", json={"space_id": 1, "threads": [thread], "active_id": "t-1"}).status_code == 200
    saved = client.get("/api/chat/history?space_id=1").json()

    assert saved["threads"][0]["entries"][0]["attachments"] == [attachment]
