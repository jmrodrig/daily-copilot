import json
import pytest
from fastapi.testclient import TestClient

import main
import spaces


@pytest.fixture
def client(notes_dir, monkeypatch):
    monkeypatch.setattr(main, "init_db", lambda: None)
    with TestClient(main.app) as c:
        yield c


def test_get_chat_history_empty_when_no_file(client):
    res = client.get("/api/chat/history?space_id=1")
    assert res.status_code == 200
    data = res.json()
    assert data["space_id"] == 1
    assert data["threads"] == []
    assert data["active_id"] is None


def test_put_and_get_chat_history(client):
    payload = {
        "space_id": 1,
        "threads": [
            {
                "id": "t-1",
                "title": "Hull review",
                "createdAt": 1729000000000,
                "updatedAt": 1729000010000,
                "entries": [
                    {"role": "user", "content": "What is the beam of C7801?", "prompt": None, "context": None},
                    {"role": "assistant", "content": "Beam is 4.2m.", "edits": [], "written": [], "toolCalls": []},
                ],
            }
        ],
        "active_id": "t-1",
    }
    put_res = client.put("/api/chat/history", json=payload)
    assert put_res.status_code == 200
    put_data = put_res.json()
    assert put_data["space_id"] == 1
    assert put_data["active_id"] == "t-1"
    assert len(put_data["threads"]) == 1
    assert put_data["threads"][0]["id"] == "t-1"

    # Verify on-disk file
    history_file = spaces.space_dir(1) / "chat_history.json"
    assert history_file.is_file()
    on_disk = json.loads(history_file.read_text(encoding="utf-8"))
    assert on_disk["space_id"] == 1
    assert on_disk["active_id"] == "t-1"
    assert len(on_disk["threads"]) == 1

    # Verify subsequent GET
    get_res = client.get("/api/chat/history?space_id=1")
    assert get_res.status_code == 200
    get_data = get_res.json()
    assert get_data["space_id"] == 1
    assert get_data["active_id"] == "t-1"
    assert len(get_data["threads"]) == 1
    assert get_data["threads"][0]["title"] == "Hull review"


def test_put_overwrites_existing_history(client):
    payload1 = {
        "space_id": 1,
        "threads": [{"id": "t-1", "title": "Old", "createdAt": 1000, "updatedAt": 1000, "entries": []}],
        "active_id": "t-1",
    }
    client.put("/api/chat/history", json=payload1)

    payload2 = {
        "space_id": 1,
        "threads": [
            {"id": "t-1", "title": "Old", "createdAt": 1000, "updatedAt": 1000, "entries": []},
            {"id": "t-2", "title": "New", "createdAt": 2000, "updatedAt": 2000, "entries": []},
        ],
        "active_id": "t-2",
    }
    res = client.put("/api/chat/history", json=payload2)
    assert res.status_code == 200
    data = res.json()
    assert data["active_id"] == "t-2"
    assert len(data["threads"]) == 2

    get_res = client.get("/api/chat/history?space_id=1")
    assert get_res.status_code == 200
    assert len(get_res.json()["threads"]) == 2


def test_chat_history_unknown_space_returns_404(client):
    get_res = client.get("/api/chat/history?space_id=99999")
    assert get_res.status_code == 404

    put_res = client.put("/api/chat/history", json={"space_id": 99999, "threads": [], "active_id": None})
    assert put_res.status_code == 404
