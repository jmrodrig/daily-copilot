import io
import zipfile

import pymupdf
import pytest
from fastapi.testclient import TestClient

import local_files
import main


@pytest.fixture
def client(notes_dir, monkeypatch):
    monkeypatch.setattr(main, "init_db", lambda: None)
    with TestClient(main.app) as client:
        yield client


@pytest.fixture
def design(tmp_path):
    root = tmp_path / "Design data"
    (root / "Hull").mkdir(parents=True)
    (root / "readme.md").write_text("# C7801 design", encoding="utf-8")
    (root / "Hull" / "model.msd").write_bytes(b"\x00maxsurf")
    doc = pymupdf.open()
    doc.new_page().insert_text((72, 72), "Keel lines C7801")
    doc.save(root / "Hull" / "lines.pdf")
    return root


def test_to_path_accepts_file_urls_and_absolute_paths(tmp_path):
    assert local_files.to_path(tmp_path.as_uri()) == tmp_path
    assert local_files.to_path(str(tmp_path)) == tmp_path
    with pytest.raises(local_files.LocalFileError):
        local_files.to_path("relative/file.txt")


def test_list_local_directory_lists_folders_first(design):
    result = local_files.list_local_directory(str(design))

    assert result["count"] == 2
    assert result["entries"] == [
        {"name": "Hull", "type": "directory", "size": 0},
        {"name": "readme.md", "type": "file", "size": len("# C7801 design")},
    ]


def test_read_local_file_reads_text_and_pdfs_and_describes_other_formats(design):
    assert local_files.read_local_file(str(design / "readme.md"))["content"] == "# C7801 design"

    pdf = local_files.read_local_file((design / "Hull" / "lines.pdf").as_uri())
    assert pdf["pages"] == 1 and "Keel lines C7801" in pdf["content"]

    other = local_files.read_local_file(str(design / "Hull" / "model.msd"))
    assert "content" not in other and "not supported" in other["message"] and other["size"] == 8

    with pytest.raises(local_files.LocalFileError):
        local_files.read_local_file(str(design))


def test_stat_reports_file_and_folder_sizes(client, design):
    folder = client.get("/api/local-files/stat", params={"path": str(design)}).json()
    assert folder["type"] == "directory" and folder["name"] == "Design data"
    assert folder["size"] == sum(f.stat().st_size for f in design.rglob("*") if f.is_file())

    assert client.get("/api/local-files/stat", params={"path": str(design / "missing")}).status_code == 404
    assert client.get("/api/local-files/stat", params={"path": "relative"}).status_code == 400


def test_download_file_and_folder_zip(client, design):
    response = client.get("/api/local-files/download", params={"path": str(design / "readme.md")})
    assert response.status_code == 200 and response.content == b"# C7801 design"
    assert "readme.md" in response.headers["content-disposition"]

    response = client.get("/api/local-files/download-zip", params={"path": design.as_uri()})
    assert response.status_code == 200
    names = set(zipfile.ZipFile(io.BytesIO(response.content)).namelist())
    assert names == {"Design data/readme.md", "Design data/Hull/model.msd", "Design data/Hull/lines.pdf"}

    assert client.get("/api/local-files/download", params={"path": str(design)}).status_code == 400
    assert client.get("/api/local-files/download-zip", params={"path": str(design / "readme.md")}).status_code == 400


def test_open_is_refused_for_remote_clients(client, design, monkeypatch):
    opened = []
    monkeypatch.setattr(local_files, "open_path", opened.append)

    # TestClient's host is "testclient", not the loopback address.
    assert client.post("/api/local-files/open", json={"path": str(design)}).status_code == 403
    assert opened == []
