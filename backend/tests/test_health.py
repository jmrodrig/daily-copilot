from fastapi.testclient import TestClient

import main


def test_health_returns_ok(monkeypatch):
    # Avoid touching the real copilot.db during tests.
    monkeypatch.setattr(main, "init_db", lambda: None)
    with TestClient(main.app) as client:
        response = client.get("/health")
    assert response.status_code == 200
    assert response.json()["status"] == "ok"
    assert response.json()["chat_model"]
