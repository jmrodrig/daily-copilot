from datetime import date, datetime, timezone

import pytest

import file_layer
from config import BACKEND_DIR, Settings
from file_layer import (
    AccessDeniedError,
    ApprovalRequiredError,
    FrontMatterError,
    NotePathError,
    read_note,
    write_note,
)
from schemas import AccessMode, Note


# --- Settings ---------------------------------------------------------------


def test_notes_dir_defaults_to_backend_notes(monkeypatch):
    monkeypatch.delenv("COPILOT_NOTES_DIR", raising=False)
    assert Settings(_env_file=None).notes_dir == (BACKEND_DIR / "notes").resolve()


def test_notes_dir_is_configurable(monkeypatch, tmp_path):
    monkeypatch.setenv("COPILOT_NOTES_DIR", str(tmp_path / "wiki"))
    assert Settings(_env_file=None).notes_dir == (tmp_path / "wiki").resolve()


def test_file_layer_uses_configured_notes_dir(notes_dir):
    write_note("page.md", "hello\n", {"title": "Page"}, "write_directly")
    assert (notes_dir / "page.md").is_file()


# --- Reading ----------------------------------------------------------------


def test_read_note_with_frontmatter(notes_dir):
    (notes_dir / "c7801").mkdir()
    (notes_dir / "c7801" / "kickoff.md").write_bytes(
        b"---\ntitle: Kickoff\nproject: C7801\ntags: [meeting, hull]\ncreated: 2026-10-01\n---\n# Kickoff\n\nNotes.\n"
    )
    note = read_note("c7801/kickoff.md")
    assert note == {
        "path": "c7801/kickoff.md",
        "frontmatter": {
            "title": "Kickoff",
            "project": "C7801",
            "tags": ["meeting", "hull"],
            "created": date(2026, 10, 1),
        },
        "content": "# Kickoff\n\nNotes.\n",
    }


def test_read_note_without_frontmatter(notes_dir):
    (notes_dir / "plain.md").write_bytes(b"# Just text\n\n---\n\nAfter a rule.\n")
    note = read_note("plain.md")
    assert note["frontmatter"] == {}
    assert note["content"] == "# Just text\n\n---\n\nAfter a rule.\n"


def test_read_note_with_unclosed_frontmatter_is_plain_content(notes_dir):
    (notes_dir / "open.md").write_bytes(b"---\ntitle: never closed\n")
    assert read_note("open.md") == {"path": "open.md", "frontmatter": {}, "content": "---\ntitle: never closed\n"}


def test_read_note_empty_frontmatter_block(notes_dir):
    (notes_dir / "empty.md").write_bytes(b"---\n---\nbody")
    note = read_note("empty.md")
    assert note["frontmatter"] == {}
    assert note["content"] == "body"


def test_read_note_preserves_crlf_and_strips_bom(notes_dir):
    (notes_dir / "win.md").write_bytes("﻿---\r\ntitle: Win\r\n---\r\nline 1\r\nline 2\r\n".encode("utf-8"))
    note = read_note("win.md")
    assert note["frontmatter"] == {"title": "Win"}
    assert note["content"] == "line 1\r\nline 2\r\n"


def test_read_note_invalid_yaml(notes_dir):
    (notes_dir / "bad.md").write_bytes(b"---\ntitle: [unclosed\n---\nbody\n")
    with pytest.raises(FrontMatterError):
        read_note("bad.md")


def test_read_note_non_mapping_frontmatter(notes_dir):
    (notes_dir / "list.md").write_bytes(b"---\n- a\n- b\n---\nbody\n")
    with pytest.raises(FrontMatterError):
        read_note("list.md")


def test_read_missing_note(notes_dir):
    with pytest.raises(FileNotFoundError):
        read_note("missing.md")


def test_read_note_validates_as_note_schema(notes_dir):
    (notes_dir / "n.md").write_bytes(b"---\ntitle: N\ntype: decision\nowner: Jose\n---\nbody\n")
    data = read_note("n.md")
    note = Note(path=data["path"], content=data["content"], **data["frontmatter"])
    assert note.title == "N"
    assert note.type == "decision"
    assert note.model_extra == {"owner": "Jose"}


# --- Round trips ------------------------------------------------------------

ROUND_TRIP_CASES = [
    pytest.param({}, "", id="empty"),
    pytest.param({}, "plain body\n", id="no-frontmatter"),
    pytest.param({"title": "T"}, "", id="frontmatter-only"),
    pytest.param({}, "---\ntitle: looks like frontmatter\n---\nbody\n", id="body-looks-like-frontmatter"),
    pytest.param({"title": "T"}, "---\nnot: frontmatter\n---\n", id="body-starts-with-delimiters"),
    pytest.param({"title": "T"}, "no trailing newline", id="no-trailing-newline"),
    pytest.param({"title": "T"}, "\n\nleading and trailing blanks\n\n\n", id="blank-lines"),
    pytest.param({"title": "T"}, "a\r\nb\r\n", id="crlf-body"),
    pytest.param({"title": "Ação — naval ⚓"}, "Unicode body: ñ, ü, 中文, 🚢\n", id="unicode"),
    pytest.param(
        {
            "title": "Design decision: hull plating",
            "project": "C7801",
            "tags": ["decision", "hull"],
            "created": date(2026, 10, 2),
            "updated": datetime(2026, 10, 2, 9, 30, tzinfo=timezone.utc),
            "estimate_hours": 2.5,
            "done": False,
            "owner": None,
            "links": {"gantt": ["T-101", "T-102"], "weight": 1},
            "colon: key": "value: with colon",
            "number_like": "007",
            "bool_like": "yes",
            "multiline": "line one\nline two\n",
        },
        "# Hull plating\n\n- [ ] check thickness\n- [x] order steel\n\n```yaml\n---\nkey: value\n---\n```\n",
        id="rich",
    ),
]


@pytest.mark.parametrize(("frontmatter", "content"), ROUND_TRIP_CASES)
def test_write_then_read_round_trip(notes_dir, frontmatter, content):
    assert write_note("rt.md", content, frontmatter, AccessMode.WRITE_DIRECTLY) is True
    assert read_note("rt.md") == {"path": "rt.md", "frontmatter": frontmatter, "content": content}


def test_frontmatter_key_order_is_preserved(notes_dir):
    frontmatter = {"zeta": 1, "alpha": 2, "mid": 3}
    write_note("order.md", "", frontmatter, "write_directly")
    assert list(read_note("order.md")["frontmatter"]) == ["zeta", "alpha", "mid"]


def test_read_then_write_preserves_hand_written_file(notes_dir):
    original = b"---\ntitle: Hand written\ntags:\n- a\n- b\n---\n# Heading\r\n\r\nBody with CRLF.\r\n"
    (notes_dir / "hand.md").write_bytes(original)
    note = read_note("hand.md")
    assert write_note("hand.md", note["content"], note["frontmatter"], "write_directly") is False
    assert (notes_dir / "hand.md").read_bytes() == original


def test_written_file_format(notes_dir):
    write_note("f.md", "# Body\n", {"title": "F", "tags": ["x"]}, "write_directly")
    assert (notes_dir / "f.md").read_bytes() == b"---\ntitle: F\ntags:\n- x\n---\n# Body\n"


def test_write_without_frontmatter_writes_content_only(notes_dir):
    write_note("plain.md", "just text\n", {}, "write_directly")
    assert (notes_dir / "plain.md").read_bytes() == b"just text\n"


def test_write_creates_parent_directories(notes_dir):
    write_note("projects/r5301/meetings/2026-10-02.md", "x", {}, "write_directly")
    assert (notes_dir / "projects" / "r5301" / "meetings" / "2026-10-02.md").is_file()


def test_overwrite_replaces_content_and_leaves_no_temp_files(notes_dir):
    write_note("o.md", "first", {"v": 1}, "write_directly")
    assert write_note("o.md", "second", {"v": 2}, "write_directly") is True
    assert read_note("o.md")["frontmatter"] == {"v": 2}
    assert read_note("o.md")["content"] == "second"
    assert [p.name for p in notes_dir.iterdir()] == ["o.md"]


def test_unchanged_write_returns_false(notes_dir):
    assert write_note("same.md", "body", {"a": 1}, "write_directly") is True
    assert write_note("same.md", "body", {"a": 1}, "write_directly") is False


def test_unserializable_frontmatter_leaves_file_untouched(notes_dir):
    write_note("keep.md", "original", {"a": 1}, "write_directly")
    with pytest.raises(FrontMatterError):
        write_note("keep.md", "new", {"obj": object()}, "write_directly")
    assert read_note("keep.md")["content"] == "original"


def test_non_string_content_is_rejected(notes_dir):
    with pytest.raises(TypeError):
        write_note("t.md", None, {}, "write_directly")


# --- Access modes -----------------------------------------------------------


def test_read_only_refuses_write(notes_dir):
    with pytest.raises(AccessDeniedError):
        write_note("ro.md", "x", {}, "read_only")
    assert not (notes_dir / "ro.md").exists()


def test_read_only_refuses_write_even_if_approved(notes_dir):
    with pytest.raises(AccessDeniedError):
        write_note("ro.md", "x", {}, AccessMode.READ_ONLY, approved=True)
    assert not (notes_dir / "ro.md").exists()


def test_read_only_does_not_touch_existing_file(notes_dir):
    write_note("existing.md", "original", {}, "write_directly")
    with pytest.raises(PermissionError):
        write_note("existing.md", "changed", {}, "read_only")
    assert read_note("existing.md")["content"] == "original"


def test_ask_first_requires_approval(notes_dir):
    with pytest.raises(ApprovalRequiredError) as excinfo:
        write_note("ask.md", "proposed", {"title": "Ask"}, "ask_first")
    assert not (notes_dir / "ask.md").exists()
    # The proposed change travels with the error so it can be shown to the user.
    assert excinfo.value.path == notes_dir / "ask.md"
    assert excinfo.value.content == "proposed"
    assert excinfo.value.frontmatter == {"title": "Ask"}


def test_ask_first_writes_when_approved(notes_dir):
    assert write_note("ask.md", "proposed", {"title": "Ask"}, "ask_first", approved=True) is True
    assert read_note("ask.md")["content"] == "proposed"


def test_write_directly_ignores_approval_flag(notes_dir):
    assert write_note("wd.md", "x", {}, "write_directly", approved=False) is True


@pytest.mark.parametrize("mode", ["", "admin", "READ_ONLY", None])
def test_unknown_access_mode_is_rejected(notes_dir, mode):
    with pytest.raises(ValueError):
        write_note("u.md", "x", {}, mode)
    assert not (notes_dir / "u.md").exists()


# --- Path confinement -------------------------------------------------------


@pytest.mark.parametrize("bad_path", ["../escape.md", "a/../../escape.md", "notes.txt", "folder", "."])
def test_paths_outside_notes_dir_or_non_markdown_are_rejected(notes_dir, bad_path):
    with pytest.raises(NotePathError):
        write_note(bad_path, "x", {}, "write_directly")
    with pytest.raises(NotePathError):
        read_note(bad_path)
    assert not (notes_dir.parent / "escape.md").exists()


def test_absolute_path_outside_notes_dir_is_rejected(notes_dir, tmp_path):
    outside = tmp_path / "outside.md"
    with pytest.raises(NotePathError):
        write_note(str(outside), "x", {}, "write_directly")
    assert not outside.exists()


def test_absolute_path_inside_notes_dir_is_allowed(notes_dir):
    write_note(str(notes_dir / "abs.md"), "x", {}, "write_directly")
    assert read_note(notes_dir / "abs.md")["path"] == "abs.md"


def test_explicit_notes_dir_argument(tmp_path):
    other = tmp_path / "other"
    write_note("n.md", "x", {"a": 1}, "write_directly", notes_dir=other)
    assert read_note("n.md", notes_dir=other) == {"path": "n.md", "frontmatter": {"a": 1}, "content": "x"}


def test_list_notes_matches_glob_relative_to_notes_dir(notes_dir):
    write_note("Inbox/b.md", "b", {}, "write_directly")
    write_note("Inbox/a.md", "a", {}, "write_directly")
    write_note("C7801/Notes-in/c.md", "c", {}, "write_directly")
    (notes_dir / "Inbox" / "skip.txt").write_text("x", encoding="utf-8")

    assert file_layer.list_notes("Inbox/*.md") == ["Inbox/a.md", "Inbox/b.md"]
    assert file_layer.list_notes("*/Notes-in/*.md") == ["C7801/Notes-in/c.md"]
    assert file_layer.list_notes("Missing/*.md") == []
