"""The Outlook .msg reader (`read_msg`), with `extract_msg` faked so no real .msg file is needed."""

import json
from datetime import datetime, timezone
from types import SimpleNamespace

import extract_msg
import pytest

import read_msg


class FakeMessage(SimpleNamespace):
    closed = False

    def close(self):
        self.closed = True


def fake_message(**overrides):
    fields = {
        "subject": "Keel drawings",
        "sender": "Zoe Smith <zoe@yard.example>",
        "to": "Sam <sam@yard.example>; ana@yard.example",
        "cc": "boss@yard.example",
        "bcc": None,
        "date": datetime(2026, 10, 7, 9, 30, tzinfo=timezone.utc),
        "body": "Hi Sam,\n\nDrawings attached.\n",
        "htmlBody": b"<p>Hi Sam,</p>",
        "attachments": [
            SimpleNamespace(longFilename="keel.pdf", shortFilename="KEEL~1.PDF", data=b"%PDF-1.7"),
            SimpleNamespace(longFilename=None, shortFilename="..\\evil?.txt", data=b"x"),
            SimpleNamespace(longFilename="keel.pdf", data=b"second"),
            SimpleNamespace(longFilename=None, shortFilename=None, displayName="Forwarded", data=FakeMessage()),
        ],
    }
    return FakeMessage(**(fields | overrides))


@pytest.fixture
def message():
    return fake_message()


@pytest.fixture
def msg_file(tmp_path, monkeypatch, message):
    path = tmp_path / "mail.msg"
    path.write_bytes(b"not really OLE")
    monkeypatch.setattr(extract_msg, "openMsg", lambda _path: message)
    return path


def test_read_msg(msg_file, message):
    data = read_msg.read_msg(msg_file)

    assert data["subject"] == "Keel drawings"
    assert data["sender"] == "Zoe Smith <zoe@yard.example>"
    assert data["to"] == ["Sam <sam@yard.example>", "ana@yard.example"]
    assert (data["cc"], data["bcc"]) == (["boss@yard.example"], [])
    assert data["date"] == "2026-10-07T09:30:00+00:00"
    assert data["body"].startswith("Hi Sam")
    assert data["html_body"] == "<p>Hi Sam,</p>"
    assert data["attachments"] == [
        {"filename": "keel.pdf", "size": 8, "extracted_path": None},
        {"filename": "..\\evil?.txt", "size": 1, "extracted_path": None},
        {"filename": "keel.pdf", "size": 6, "extracted_path": None},
        {"filename": "Forwarded", "size": None, "extracted_path": None},
    ]
    assert message.closed


def test_extract_attachments(msg_file, tmp_path):
    out = tmp_path / "out"
    data = read_msg.read_msg(msg_file, out)

    saved = [item["extracted_path"] for item in data["attachments"]]
    assert saved[3] is None  # an embedded message has no file contents
    assert [p.split("\\")[-1].split("/")[-1] for p in saved[:3]] == ["keel.pdf", "evil_.txt", "keel (2).pdf"]
    assert (out / "keel.pdf").read_bytes() == b"%PDF-1.7"
    assert (out / "keel (2).pdf").read_bytes() == b"second"
    assert sorted(p.name for p in out.iterdir()) == ["evil_.txt", "keel (2).pdf", "keel.pdf"]


def test_missing_and_invalid_files(tmp_path, monkeypatch):
    with pytest.raises(read_msg.MsgReadError, match="File not found"):
        read_msg.read_msg(tmp_path / "nope.msg")

    bad = tmp_path / "bad.msg"
    bad.write_text("plain text, not an Outlook message")
    with pytest.raises(read_msg.MsgReadError, match="Not a readable Outlook .msg file"):
        read_msg.read_msg(bad)  # the real extract_msg rejects it


def test_format_msg_for_display(msg_file):
    text = read_msg.format_msg_for_display(read_msg.read_msg(msg_file))

    assert "Subject: Keel drawings" in text
    assert "To:      Sam <sam@yard.example>, ana@yard.example" in text
    assert "Bcc" not in text
    assert "  - keel.pdf (8 B)" in text
    assert "  - Forwarded (embedded item)" in text
    assert text.rstrip().endswith("Drawings attached.")

    empty = read_msg.format_msg_for_display({"subject": "", "body": "", "html_body": "<p>x</p>"})
    assert "Subject: (no subject)" in empty
    assert "HTML body available" in empty


def test_cli(msg_file, tmp_path, capsys):
    assert read_msg.main([str(msg_file)]) == 0
    assert "Subject: Keel drawings" in capsys.readouterr().out

    assert read_msg.main([str(msg_file), "--json"]) == 0
    assert json.loads(capsys.readouterr().out)["to"] == ["Sam <sam@yard.example>", "ana@yard.example"]

    assert read_msg.main([str(msg_file), "--extract-attachments"]) == 0
    assert (tmp_path / "mail_attachments" / "keel.pdf").exists()

    out = tmp_path / "chosen"
    assert read_msg.main([str(msg_file), "--json", "--extract-attachments", str(out)]) == 0
    assert (out / "keel.pdf").exists()
    capsys.readouterr()

    assert read_msg.main([str(tmp_path / "missing.msg")]) == 1
    assert "File not found" in capsys.readouterr().err


def test_parser_arguments():
    parser = read_msg.build_parser()
    args = parser.parse_args(["a.msg"])
    assert (args.msg_file, args.json, args.extract_attachments) == ("a.msg", False, None)
    assert parser.parse_args(["a.msg", "--extract-attachments"]).extract_attachments == ""
    assert parser.parse_args(["a.msg", "--extract-attachments", "dir", "--json"]).json is True
    with pytest.raises(SystemExit):
        parser.parse_args([])


def test_format_summary_is_the_display_formatter():
    assert read_msg.format_summary is read_msg.format_msg_for_display


def test_read_local_file_reads_outlook_messages(msg_file):
    import local_files

    result = local_files.read_local_file(str(msg_file))

    assert (result["subject"], result["from"], result["attachments"]) == ("Keel drawings", "Zoe Smith <zoe@yard.example>", 4)
    assert result["path"] == str(msg_file) and result["size"] == len(b"not really OLE")
    assert "Subject: Keel drawings" in result["content"]
    assert "Drawings attached." in result["content"]


def test_read_local_file_reports_unreadable_outlook_messages(tmp_path):
    import local_files

    bad = tmp_path / "bad.msg"
    bad.write_text("plain text, not an Outlook message")
    with pytest.raises(local_files.LocalFileError, match="Could not read the Outlook message"):
        local_files.read_local_file(str(bad))


def test_msg_chat_attachment_text_is_embedded(notes_dir, monkeypatch, message):
    import agent
    import file_layer
    from schemas import ChatMessage

    monkeypatch.setattr(extract_msg, "openMsg", lambda _path: message)
    asset = file_layer.save_asset(b"not really OLE", "application/vnd.ms-outlook", "mail.msg", notes_dir=notes_dir)
    attachment = {"name": "mail.msg", "url": f"/api/notes/image/{asset}?space_id=1", "size": 14}

    text = agent._message_text(ChatMessage(role="user", content="Reply to this", attachments=[attachment]), notes_dir)

    assert '[Attached file: "mail.msg"' in text
    assert '<attachment_content name="mail.msg">' in text
    assert "Subject: Keel drawings" in text and "Drawings attached." in text


def test_unreadable_msg_chat_attachment_gets_only_its_path(notes_dir):
    import agent
    import file_layer
    from schemas import ChatMessage

    asset = file_layer.save_asset(b"plain text, not an Outlook message", "application/vnd.ms-outlook", "mail.msg", notes_dir=notes_dir)
    attachment = {"name": "bad.msg", "url": f"/api/notes/image/{asset}?space_id=1"}

    text = agent._message_text(ChatMessage(role="user", content="Read this", attachments=[attachment]), notes_dir)

    assert '[Attached file: "bad.msg"' in text and "<attachment_content" not in text
