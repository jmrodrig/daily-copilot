import io
import sys
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


def test_search_local_files_matches_names_at_any_depth(design):
    (design / "Hull" / "Scantlings").mkdir()
    (design / "Hull" / "Scantlings" / "C7801 scantling calc.xlsx").write_bytes(b"xlsx")
    (design / ".git").mkdir()
    (design / ".git" / "scantling.txt").write_text("hidden", encoding="utf-8")

    result = local_files.search_local_files(str(design), "SCANTLING")

    assert result["path"] == str(design) and result["query"] == "SCANTLING"
    assert result["count"] == 2 and result["truncated"] is False
    assert result["matches"] == [
        {"name": "Scantlings", "path": str(design / "Hull" / "Scantlings"), "type": "directory", "size": 0},
        {
            "name": "C7801 scantling calc.xlsx",
            "path": str(design / "Hull" / "Scantlings" / "C7801 scantling calc.xlsx"),
            "type": "file",
            "size": 4,
        },
    ]


def test_search_local_files_takes_keywords_and_globs(design):
    def names(query):
        return [m["name"] for m in local_files.search_local_files(design.as_uri(), query)["matches"]]

    assert names("keel") == []
    assert names("lines pdf") == ["lines.pdf"]
    assert names("*.PDF") == ["lines.pdf"]
    assert names("read*") == ["readme.md"]
    with pytest.raises(local_files.LocalFileError):
        local_files.search_local_files(str(design), "  ")
    with pytest.raises(local_files.LocalFileError):
        local_files.search_local_files(str(design / "readme.md"), "x")
    with pytest.raises(FileNotFoundError):
        local_files.search_local_files(str(design / "missing"), "x")


def test_search_local_files_stops_at_its_limits(design, monkeypatch):
    for i in range(5):
        (design / f"match {i}.txt").write_text("x", encoding="utf-8")

    monkeypatch.setattr(local_files, "SEARCH_MATCH_LIMIT", 3)
    result = local_files.search_local_files(str(design), "match")
    assert result["count"] == 3 and result["truncated"] is True

    monkeypatch.setattr(local_files, "SEARCH_MATCH_LIMIT", 100)
    monkeypatch.setattr(local_files, "SEARCH_SCAN_LIMIT", 2)
    result = local_files.search_local_files(str(design), "match")
    assert result["truncated"] is True


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


def test_check_path_reports_files_folders_and_missing_paths(design):
    folder = local_files.check_path(design.as_uri())
    assert folder == {"exists": True, "name": "Design data", "type": "directory", "path": str(design), "unc_path": str(design)}

    file = local_files.check_path(str(design / "readme.md"))
    assert file["exists"] and file["type"] == "file" and file["name"] == "readme.md"

    missing = local_files.check_path(str(design / "missing.txt"))
    assert not missing["exists"] and missing["type"] == "unknown" and "No file or folder" in missing["error"]

    relative = local_files.check_path("relative/file.txt")
    assert not relative["exists"] and relative["path"] == "relative/file.txt" and "Not an absolute path" in relative["error"]


def test_check_path_does_not_walk_folders(design, monkeypatch):
    monkeypatch.setattr(local_files.Path, "rglob", lambda *_: pytest.fail("check_path must not walk the folder"))
    monkeypatch.setattr(local_files.Path, "iterdir", lambda *_: pytest.fail("check_path must not list the folder"))
    assert local_files.check_path(str(design))["exists"]


def test_check_endpoint(client, design):
    found = client.get("/api/local-files/check", params={"path": str(design)})
    assert found.status_code == 200 and found.json()["exists"] and found.json()["type"] == "directory"

    missing = client.get("/api/local-files/check", params={"path": str(design / "missing")})
    assert missing.status_code == 200 and missing.json()["exists"] is False and missing.json()["error"]

    relative = client.get("/api/local-files/check", params={"path": "relative"})
    assert relative.status_code == 200 and relative.json()["exists"] is False


def test_stat_stops_counting_a_huge_folder(client, design, monkeypatch):
    monkeypatch.setattr(local_files, "STAT_LIMIT", 2)
    folder = client.get("/api/local-files/stat", params={"path": str(design)}).json()
    assert folder["partial"] is True
    assert 0 < folder["size"] < sum(f.stat().st_size for f in design.rglob("*") if f.is_file())

    whole = client.get("/api/local-files/stat", params={"path": str(design / "Hull")}).json()
    assert whole["partial"] is False


windows_only = pytest.mark.skipif(sys.platform != "win32", reason="drive letters and UNC paths are Windows paths")
SHARE = r"\\syfileapp1\Archive Data\Older Yachts"


@windows_only
def test_to_unc_path_resolves_mapped_drives_and_keeps_unc_paths(monkeypatch):
    drives = []

    def wnet_get_connection(drive, buffer, _size):
        drives.append(drive)
        if drive != "O:":
            return 2250  # ERROR_NOT_CONNECTED: not a network drive
        buffer.value = SHARE
        return 0

    import ctypes

    monkeypatch.setattr(ctypes.windll.mpr, "WNetGetConnectionW", wnet_get_connection)

    expected = SHARE + r"\Lawrences Files"
    assert local_files.to_unc_path(r"O:\Lawrences Files") == expected
    assert local_files.to_unc_path("file:///O:/Lawrences%20Files") == expected
    assert local_files.to_unc_path("O:\\") == SHARE + "\\"
    assert local_files.to_unc_path(r"C:\Projects\C7801") == r"C:\Projects\C7801"
    assert drives == ["O:", "O:", "O:", "C:"]

    assert local_files.to_unc_path("//syfileapp1/Archive Data/x") == r"\\syfileapp1\Archive Data\x"
    assert local_files.to_unc_path("file://syfileapp1/Archive%20Data/x") == r"\\syfileapp1\Archive Data\x"
    assert drives == ["O:", "O:", "O:", "C:"]  # a UNC path isn't looked up


@windows_only
def test_shortcut_points_at_the_network_share(design, monkeypatch):
    monkeypatch.setattr(local_files, "to_unc_path", lambda _raw: SHARE + r"\Lawrences Files")
    content, name, unc = local_files.generate_shortcut_content(str(design))

    assert name == "Design data.url"
    assert unc == SHARE + r"\Lawrences Files"
    assert content == "[InternetShortcut]\r\nURL=file://syfileapp1/Archive%20Data/Older%20Yachts/Lawrences%20Files\r\n"


def test_shortcut_endpoint(client, design):
    response = client.get("/api/local-files/shortcut", params={"path": str(design / "readme.md")})

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("application/x-mswinurl")
    assert response.headers["content-disposition"].startswith('attachment; filename="readme.md.url"')
    lines = response.text.splitlines()
    assert lines[0] == "[InternetShortcut]"
    assert lines[1] == f"URL={(design / 'readme.md').as_uri()}"

    assert client.get("/api/local-files/shortcut", params={"path": str(design / "missing")}).status_code == 404
    assert client.get("/api/local-files/shortcut", params={"path": "relative"}).status_code == 400


def test_shortcut_endpoint_names_non_ascii_files(client, design):
    (design / "Plan – é.txt").write_text("x", encoding="utf-8")
    response = client.get("/api/local-files/shortcut", params={"path": str(design / "Plan – é.txt")})

    assert response.status_code == 200
    assert "filename*=UTF-8''Plan%20%E2%80%93%20%C3%A9.txt.url" in response.headers["content-disposition"]
    assert response.text.isascii()


def test_stat_and_check_report_the_unc_path(client, design):
    assert client.get("/api/local-files/stat", params={"path": str(design)}).json()["unc_path"] == str(design)
    assert client.get("/api/local-files/check", params={"path": str(design)}).json()["unc_path"] == str(design)
