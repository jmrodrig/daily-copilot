"""Read Outlook email files (`.msg`): headers, body and attachments, for the agent or a person at a shell.

    python read_msg.py mail.msg                          # readable summary
    python read_msg.py mail.msg --json                   # everything as JSON
    python read_msg.py mail.msg --extract-attachments    # also save attachments next to the file
    python read_msg.py mail.msg --extract-attachments out/

Uses `extract_msg` (imported when a file is read, so the backend runs without it).
"""

import argparse
import html
import json
import re
import sys
from datetime import datetime
from pathlib import Path
from typing import Any


class MsgReadError(Exception):
    """The file is missing, isn't an Outlook message, or couldn't be read."""


def _recipients(value: Any) -> list[str]:
    """`to`/`cc`/`bcc` as a list of addresses: extract_msg gives one "a; b" string (or None)."""
    if not value:
        return []
    return [part.strip() for part in re.split(r"[;\n]", str(value)) if part.strip()]


def _date(value: Any) -> str | None:
    if value is None:
        return None
    return value.isoformat() if isinstance(value, datetime) else str(value)


def _html(value: Any) -> str | None:
    if not value:
        return None
    return value.decode("utf-8", errors="replace") if isinstance(value, bytes) else str(value)


_SKIPPED_TAGS = ("script", "style", "head", "meta", "title")
_BLOCK_TAGS = (
    "p", "div", "tr", "li", "ul", "ol", "table", "blockquote", "pre", "hr",
    "h1", "h2", "h3", "h4", "h5", "h6", "dt", "dd", "section", "article", "header", "footer",
)


def _normalize_text(text: str) -> str:
    """Trim each line, drop non-breaking spaces and keep at most one blank line between paragraphs."""
    lines = [re.sub(r"[ \t\f\v\u00a0]+", " ", line).strip() for line in text.replace("\r\n", "\n").split("\n")]
    return re.sub(r"\n{3,}", "\n\n", "\n".join(lines)).strip()


def _html_to_text_bs4(html_str: str) -> str:
    from bs4 import BeautifulSoup, Comment

    soup = BeautifulSoup(html_str, "html.parser")
    for tag in soup.find_all(_SKIPPED_TAGS):
        tag.decompose()
    for comment in soup.find_all(string=lambda s: isinstance(s, Comment)):
        comment.extract()
    # Line breaks in the HTML source are just spaces; only the markup decides where lines end.
    for string in soup.find_all(string=True):
        if not string.find_parent("pre"):
            string.replace_with(re.sub(r"\s+", " ", str(string)))
    for br in soup.find_all("br"):
        br.replace_with("\n")
    for tag in soup.find_all(_BLOCK_TAGS):
        tag.append("\n")
    for cell in soup.find_all(("td", "th")):
        cell.append("\t")
    return soup.get_text()


def _html_to_text_re(html_str: str) -> str:
    skipped, blocks = "|".join(_SKIPPED_TAGS), "|".join(_BLOCK_TAGS)
    text = re.sub(r"<!--.*?-->", "", html_str, flags=re.S)
    text = re.sub(rf"<({skipped})\b[^>]*>.*?</\1\s*>", "", text, flags=re.S | re.I)
    text = re.sub(r"\s+", " ", text)
    text = re.sub(r"<br\b[^>]*>", "\n", text, flags=re.I)
    text = re.sub(rf"</({blocks})\s*>|<hr\b[^>]*>", "\n", text, flags=re.I)
    text = re.sub(r"</t[dh]\s*>", "\t", text, flags=re.I)
    return html.unescape(re.sub(r"<[^>]+>", "", text))


def html_to_plain_text(html_str: str) -> str:
    """Readable plain text from an HTML email body: no scripts, styles or tags, entities decoded, one line per
    paragraph. Uses BeautifulSoup when it's installed, a regular-expression fallback otherwise."""
    if not html_str:
        return ""
    try:
        text = _html_to_text_bs4(html_str)
    except ImportError:
        text = _html_to_text_re(html_str)
    return _normalize_text(text)


def _safe_filename(name: str, taken: set[str]) -> str:
    """`name` without path parts or characters Windows refuses, made unique among `taken`."""
    name = re.sub(r'[<>:"|?*\x00-\x1f]', "_", re.split(r"[\\/]", name)[-1]).strip(" .") or "attachment"
    stem, suffix = Path(name).stem, Path(name).suffix
    candidate, n = name, 1
    while candidate.lower() in taken:
        n += 1
        candidate = f"{stem} ({n}){suffix}"
    taken.add(candidate.lower())
    return candidate


def _attachment_bytes(attachment: Any) -> bytes | None:
    """An attachment's contents, or None for embedded messages and other non-file attachments."""
    data = getattr(attachment, "data", None)
    return data if isinstance(data, bytes) else None


def read_msg(file_path: str | Path, extract_attachments_dir: str | Path | None = None) -> dict[str, Any]:
    """The message in `file_path` as a dict: subject, sender, to, cc, bcc, date (ISO), body, html_body and
    attachments (`filename`, `size`, and `extracted_path` when saved to `extract_attachments_dir`).

    Raises `MsgReadError` if the file is missing or isn't a readable Outlook message.
    """
    path = Path(file_path)
    if not path.is_file():
        raise MsgReadError(f"File not found: {path}")
    try:
        import extract_msg
    except ImportError as exc:  # pragma: no cover - depends on the environment
        raise MsgReadError("extract_msg is not installed (pip install extract-msg)") from exc

    try:
        msg = extract_msg.openMsg(str(path))
    except Exception as exc:  # extract_msg raises many types for corrupt or non-OLE files
        raise MsgReadError(f"Not a readable Outlook .msg file: {path} ({exc})") from exc

    try:
        out_dir = Path(extract_attachments_dir) if extract_attachments_dir is not None else None
        if out_dir is not None:
            out_dir.mkdir(parents=True, exist_ok=True)
        taken: set[str] = set()
        attachments = []
        for index, attachment in enumerate(getattr(msg, "attachments", None) or [], start=1):
            filename = (
                getattr(attachment, "longFilename", None)
                or getattr(attachment, "shortFilename", None)
                or getattr(attachment, "displayName", None)
                or f"attachment-{index}"
            )
            data = _attachment_bytes(attachment)
            item: dict[str, Any] = {"filename": filename, "size": len(data) if data is not None else None}
            if out_dir is not None and data is not None:
                target = out_dir / _safe_filename(filename, taken)
                target.write_bytes(data)
                item["extracted_path"] = str(target)
            else:
                item["extracted_path"] = None
            attachments.append(item)

        html_body = _html(msg.htmlBody)
        body = msg.body or ""
        if not body.strip() and html_body:
            body = html_to_plain_text(html_body)
        return {
            "subject": msg.subject or "",
            "sender": msg.sender or "",
            "to": _recipients(msg.to),
            "cc": _recipients(msg.cc),
            "bcc": _recipients(msg.bcc),
            "date": _date(msg.date),
            "body": body,
            "html_body": html_body,
            "attachments": attachments,
        }
    except MsgReadError:
        raise
    except Exception as exc:
        raise MsgReadError(f"Could not read {path}: {exc}") from exc
    finally:
        msg.close()


def _size(size: int | None) -> str:
    if size is None:
        return "embedded item"
    if size < 1024:
        return f"{size} B"
    if size < 1024 * 1024:
        return f"{size / 1024:.1f} KB"
    return f"{size / (1024 * 1024):.1f} MB"


def format_msg_for_display(data: dict[str, Any]) -> str:
    """A readable summary of `read_msg`'s result: headers, attachments, then the plain text body."""
    lines = [
        f"Subject: {data.get('subject') or '(no subject)'}",
        f"From:    {data.get('sender') or '(unknown)'}",
    ]
    for label, key in (("To:     ", "to"), ("Cc:     ", "cc"), ("Bcc:    ", "bcc")):
        if data.get(key):
            lines.append(f"{label} {', '.join(data[key])}")
    if data.get("date"):
        lines.append(f"Date:    {data['date']}")
    attachments = data.get("attachments") or []
    if attachments:
        lines.append(f"Attachments ({len(attachments)}):")
        for item in attachments:
            saved = f" -> {item['extracted_path']}" if item.get("extracted_path") else ""
            lines.append(f"  - {item['filename']} ({_size(item.get('size'))}){saved}")
    body = (data.get("body") or "").strip()
    if not body and data.get("html_body"):
        body = html_to_plain_text(data["html_body"])
    lines += ["", "-" * 60, body or "(empty body)"]
    return "\n".join(lines)


format_summary = format_msg_for_display


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Read an Outlook .msg email file.")
    parser.add_argument("msg_file", help="Path to the .msg file")
    parser.add_argument("--json", action="store_true", help="Print everything as JSON")
    parser.add_argument(
        "--extract-attachments",
        nargs="?",
        const="",
        default=None,
        metavar="DIR",
        help="Save the attachments to DIR (default: a '<file name>_attachments' folder next to the file)",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    out_dir = args.extract_attachments
    if out_dir == "":
        msg_path = Path(args.msg_file)
        out_dir = msg_path.with_name(f"{msg_path.stem}_attachments")
    try:
        data = read_msg(args.msg_file, out_dir)
    except MsgReadError as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1
    if args.json:
        print(json.dumps(data, indent=2, ensure_ascii=False))
    else:
        print(format_msg_for_display(data))
    return 0


if __name__ == "__main__":
    # Email bodies often hold characters the Windows console code page can't print.
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.exit(main())
