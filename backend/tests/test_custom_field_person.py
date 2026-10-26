"""Person custom fields: a person's name picked from the space's People directory."""

import pytest
from fastapi.testclient import TestClient

import main


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setattr(main, "init_db", lambda: None)
    with TestClient(main.app) as client:
        yield client


@pytest.fixture
def person_field(client):
    response = client.put(
        "/api/spaces/1",
        json={
            "custom_fields_schema": [
                {"id": "reviewer", "name": "Reviewer", "type": "person", "options": ["x"], "colors": {"x": "#ff0000"}},
                {"id": "hull", "name": "Hull", "type": "text"},
            ]
        },
    )
    assert response.status_code == 200, response.text
    return response.json()["custom_fields_schema"][0]


def new_task(client, title, **fields):
    response = client.post("/api/tasks", json={"space_id": 1, "title": title, **fields})
    assert response.status_code == 201, response.text
    return response.json()


def test_space_saves_a_person_field_without_options(person_field):
    # Only dropdowns keep options and colours.
    assert person_field == {
        "id": "reviewer",
        "name": "Reviewer",
        "type": "person",
        "options": [],
        "colors": {},
        "show_inline": False,
    }


def test_person_value_is_set_updated_and_cleared(client, person_field):
    task = new_task(client, "Keel", custom_fields={"reviewer": "  Ana Silva "})
    assert task["custom_fields"] == {"reviewer": "Ana Silva"}

    patched = client.patch(f"/api/tasks/{task['id']}", json={"custom_fields": {"reviewer": "Bruno"}})
    assert patched.status_code == 200, patched.text
    assert patched.json()["custom_fields"] == {"reviewer": "Bruno"}

    # Names are capped like the other short values.
    long = client.patch(f"/api/tasks/{task['id']}", json={"custom_fields": {"reviewer": "x" * 200}})
    assert long.json()["custom_fields"] == {"reviewer": "x" * 128}

    for empty in ("", "   ", None):
        client.patch(f"/api/tasks/{task['id']}", json={"custom_fields": {"reviewer": "Bruno"}})
        cleared = client.patch(f"/api/tasks/{task['id']}", json={"custom_fields": {"reviewer": empty}})
        assert cleared.json()["custom_fields"] == {}


@pytest.mark.parametrize("value", [12, 4.5, True, ["Ana"], {"name": "Ana"}])
def test_person_value_must_be_a_name(client, person_field, value):
    task = new_task(client, "Keel")
    assert client.patch(f"/api/tasks/{task['id']}", json={"custom_fields": {"reviewer": value}}).status_code == 400
    response = client.post("/api/tasks", json={"space_id": 1, "title": "x", "custom_fields": {"reviewer": value}})
    assert response.status_code == 400


def test_bulk_update_sets_a_person(client, person_field):
    a, b = (new_task(client, title)["id"] for title in ("A", "B"))
    response = client.post(
        "/api/tasks/bulk-update", json={"task_ids": [a, b], "updates": {"custom_fields": {"reviewer": "Ana"}}}
    )
    assert response.status_code == 200, response.text
    assert [client.get(f"/api/tasks/{i}").json()["custom_fields"] for i in (a, b)] == [{"reviewer": "Ana"}] * 2


def test_person_field_filters(client, person_field):
    new_task(client, "A", custom_fields={"reviewer": "Ana Silva"})
    new_task(client, "B", custom_fields={"reviewer": "Bruno"})
    new_task(client, "C")

    def cf(*filters):
        return [t["title"] for t in client.get("/api/tasks", params={"space_id": 1, "cf": list(filters)}).json()]

    assert cf("reviewer:Ana Silva") == ["A"]
    assert cf("reviewer:ana") == ["A"]  # case-insensitive, anywhere in the name
    assert cf("reviewer:SILVA") == ["A"]
    assert cf("reviewer:") == ["C"]
    assert cf("reviewer:*") == ["A", "B"]
    assert cf("reviewer:Carla") == []


def test_changing_a_field_to_and_from_person_keeps_names(client, person_field):
    task = new_task(client, "Keel", custom_fields={"reviewer": "Ana", "hull": "Bruno"})
    response = client.put(
        "/api/spaces/1",
        json={
            "custom_fields_schema": [
                {"id": "reviewer", "name": "Reviewer", "type": "text"},
                {"id": "hull", "name": "Hull", "type": "person"},
            ]
        },
    )
    assert response.status_code == 200, response.text
    assert client.get(f"/api/tasks/{task['id']}").json()["custom_fields"] == {"reviewer": "Ana", "hull": "Bruno"}

    # A value that isn't a name is cleared when its field becomes a person field.
    client.put(
        "/api/spaces/1",
        json={"custom_fields_schema": [{"id": "hull", "name": "Hull", "type": "number"}]},
    )
    client.patch(f"/api/tasks/{task['id']}", json={"custom_fields": {"hull": 3}})
    client.put("/api/spaces/1", json={"custom_fields_schema": [{"id": "hull", "name": "Hull", "type": "person"}]})
    assert client.get(f"/api/tasks/{task['id']}").json()["custom_fields"] == {}
